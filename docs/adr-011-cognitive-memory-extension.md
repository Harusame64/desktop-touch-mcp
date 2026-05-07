# ADR-011 Plan — Cognitive Memory Extension (Phase A: expansion phase carry-over wire)

- Status: **Drafted v0.6 (Round 1-4 Opus review + Codex re-review 全 findings apply 済、User reviewer 補正 window 待ち)**
- Date: 2026-05-07
- Authors: Claude (Sonnet) — project `desktop-touch-mcp`
- 親 ADR: `docs/adr-010-presentation-layer-self-documenting-envelope.md` §6 (CoALA memory mapping) + §11 OQ #8 / #9
- 関連:
  - `docs/architecture-3layer-integrated.md` §4 (識別子ヒエラルキー、session_id) + §16 (SSOT 整合)
  - `docs/layer-constraints.md` §5 (L4 envelope assembly) + §6 (L5 tool surface)
  - `docs/walking-skeleton-expansion-plan.md` §6.1 (carry-over 4 項目)
  - `docs/adr-010-p1-s5-plan.md` §1.1 E-2 (sentinel runtime closed loop) + §2.4 (sessionId source)
  - `docs/adr-008-d2-c-followups.md` (D2-C carry-over OQ、本 plan scope 外だが reference)
- 北極星: LLM の不安を消す + 復帰経路を typed に提供 + Tool 数を増やさず 1 tool の表現力を上げる
- スコープ宣言: 本 plan は **Phase A = expansion phase carry-over 4 項目 + ADR-010 §11 OQ #8 / #9 wire 完了** に scope 限定。CoALA 全 4 memory layer (Working / Episodic / Semantic / Procedural) を扱う **Phase B は別 sub-plan** (`docs/adr-011-phase-b-coala-plan.md` 起草予定) で扱う。

---

## 1. Context

### 1.1 起源

walking skeleton expansion phase (PR #126-#146、2026-05-03 完了) で 28 public tool 全てが L5 envelope に統一適用された。Opus phase 境界 review (2026-05-03、agent a5dc69bc15133a67b) で **3 者一致 PARTIAL** の判定根拠となった 4 項目が、ADR-011 wire 対象として `docs/walking-skeleton-expansion-plan.md` §6.1 に永続化された。

加えて ADR-010 §11 OQ #8 / #9 が「ADR-011 着手前 / 着手時 に検討」として残されている。これらは memory ではなく docs に永続化されている (CLAUDE.md 強制命令 9 整合)。

本 plan は **これら carry-over 項目を Phase A として最短で消化** し、CoALA 全体設計 (working / episodic / semantic / procedural memory) を Phase B として別 sub-plan に切り出す方針を取る。

### 1.2 北極星整合

ADR-010 §1 の北極星「LLM の不安を消す + 復帰経路を typed に提供 + Tool 数を増やさず 1 tool の表現力を上げる」に対し、Phase A は以下で寄与する:

| 北極星要素 | Phase A 寄与 |
|---|---|
| LLM の不安を消す | `include=["causal"]` を 9 query tool 中 8 (= desktop_state 配線済 1 件を除く wire 対象 8 tool) で受けても caused_by 空返しの **residual contract gap** を閉じる (A-1)。`your_last_action` が常に正しく projection される |
| Causal Continuity (ADR-010 §4.2) | run_macro の compound commit boundary が ring eviction で消失する不整合を閉じる (A-3) |
| 復帰経路 typed | sessionId source の sentinel runtime closed-loop を実 transport binding に置換、`multi:disabled` 検出経路を production で生かす (A-2) |
| Tool 数増やさない | 既存 28 tool surface 不変 (統合書 P7)、registration handler / projector 配線のみで wire 完了 |

### 1.3 Phase A scope (4 wire 項目)

`docs/walking-skeleton-expansion-plan.md` §6.1 + ADR-010 §11 OQ #8 / #9 から:

| # | 項目 | 検出 line | 設計軸 |
|---|---|---|---|
| **A-1** | 8 query tool caused_by wiring | `_envelope.ts:1587-1589` (S4 fast path)、`desktop-register.ts:601` (desktop_discover)、`browser.ts:2236, 2249`、`workspace.ts:297`、`screenshot.ts:1177`、`wait-until.ts:390`、`server-status.ts:34` | `desktopStateCausedByProjector` の汎用化 + 8 query tool 全てへ mechanical コピー |
| **A-2** | sessionId source finalize | `desktop-state.ts:753` (`getMcpTransportSessionId` stub 定義)、`desktop-state.ts:768-793` (`desktopStateGetSessionId` resolver)、`desktop-state.ts:790` (sentinel branch `return "multi:disabled"`)、`_envelope.ts:1380` (commit-axis `getSessionId` default `() => "default"`)、`_envelope.ts:1598` (query-axis `getSessionId` default `() => "default"`) | MCP request context (McpServer / RequestContext API) からの session_id 取得経路実装 |
| **A-3** | run_macro compound commit boundary | `macro.ts:498-505` (caveat 記述済)、`_envelope.ts:955` (`HISTORY_BUFFER_CAPACITY = 8` SSOT) | outer run_macro event を **eviction 保護** flag で ring 内 preserve、step event は通常通り FIFO evict |
| **A-4** | PR #141-#146 Codex review gap clearance | PR #141-#146 (Codex usage limit 中の Opus 単独 merge) | Codex usage 復帰後の振り返り review、検出 finding は別 PR で fix |

### 1.4 Phase B scope (本 plan 言及のみ、別 sub-plan で詳細)

ADR-010 §6 (CoALA memory mapping) + ADR-010 P6 acceptance:

| memory type | 対応 phase | 本 plan |
|---|---|---|
| Working memory (`include=working:N`) | ADR-011 Phase B / ADR-010 P6 | scope 外 |
| Episodic memory (`include=episodic:N`、history buffer expose) | ADR-011 Phase B / ADR-010 P6 | scope 外 (既存 history buffer は A-3 で boundary preserve のみ) |
| Semantic memory (`learned_ui_pattern`) | ADR-011 Phase B | scope 外 |
| Procedural memory (`successful_macros`) | ADR-011 Phase B | scope 外 |

Phase B は CoALA 全体設計 (4 memory layer + L4 view 設計 + envelope projection + bench) で大規模、本 plan の Phase A wire 完了後に別 sub-plan として起草する。

### 1.5 SSOT 参照

本 plan の不変条件・SLO・境界は以下を SSOT とする:
- 識別子ヒエラルキー (session_id) → 統合書 §4
- L4 envelope assembly 制約 (p99 < 5ms) → layer-constraints §5
- L5 tool surface 制約 (query/commit SLO) → layer-constraints §6
- typed reason 37 codes → ADR-010 §5.4 + `src/tools/_errors.ts`
- HISTORY_BUFFER_CAPACITY SSOT → `src/tools/_envelope.ts` (`const HISTORY_BUFFER_CAPACITY = 8`、grep keyword で正確 line を取得)
- causedByProjector 既存 reference impl → `src/tools/desktop-state.ts` `desktopStateCausedByProjector` (grep keyword)
- sessionId stub SSOT → `src/tools/desktop-state.ts` `getMcpTransportSessionId` / `desktopStateGetSessionId` (grep keyword)
- `getSessionId` default SSOT → `src/tools/_envelope.ts` `makeCommitWrapper` 内 (commit-axis) + `makeQueryWrapper` 内 (query-axis、grep keyword)
- ADR-011 A-3 新導入 SSOT (PR #157 land 後) → `src/tools/_envelope.ts` `ToolCallEvent.isCompoundBoundary` / `evictOldestNonBoundary` / `selectLastEventForCausalProjection` / `CommitWrapperOptions.isCompoundBoundary` / `L1ToolCallStartedArgs.isCompoundBoundary` (grep keyword)

本 plan で記述された規約と SSOT の間に齟齬が生じた場合、SSOT を優先し、本 plan は後追い更新する (統合書 §16.1 整合)。

**Line ref drift 注記** (Round 1 A-1 PR #156 P2-3 反映): 本 plan の `file.ts:NNN` 形式の line refs は **drafting 時点の indicative 値**。本 plan land 後の改修で line drift が発生する (例: A-1 で `genericQueryCausedByProjector` 追加により `_envelope.ts` の S4 fast path / `getSessionId` default 等の line 数が +160 程度ずれる)。**実 line を grep keyword で検索**することを推奨:
- `desktopStateCausedByProjector` / `desktopStateGetSessionId` / `getMcpTransportSessionId` / `genericQueryCausedByProjector` / `defaultQuerySessionId` / `_isSingleSessionPrototype` / `HISTORY_BUFFER_CAPACITY` / `isCompoundBoundary` / `evictOldestNonBoundary` / `buildCausedBy` / `buildBasedOn` / `ToolCallEvent` / `pushHistoryStarted` / `evictHistoryIfNeeded`

実 line ref の sync は本 plan の各 phase land 時に follow-up commit で更新するか、本注記により grep 経路を維持する (CLAUDE.md §3.1 fact 整合 sweep 整合)。

---

## 2. Decision

### 2.1 主要決定 (5 項目)

| # | 項目 | 決定 |
|---|---|---|
| 1 | Phase A vs Phase B 分離 | Phase A = expansion phase carry-over 4 項目のみ、Phase B (CoALA 全体) は別 sub-plan |
| 2 | A-1 causedByProjector 共通化 | `desktopStateCausedByProjector` の汎用化版 `genericQueryCausedByProjector` を `_envelope.ts` に extract、8 query tool で reuse |
| 3 | A-2 sessionId source 取得経路 | MCP SDK の `RequestContext` 経由で session_id 取得、stub `getMcpTransportSessionId()` を実装に置換、`multi:disabled` sentinel は **multi-session detection** logic で生かす |
| 4 | A-3 compound commit boundary 保護 | `ToolCallEvent` に `isCompoundBoundary: boolean` flag 追加、`evictHistoryIfNeeded` で boundary entry を eviction 対象外に flag、ring capacity は 8 維持 (capacity 増は Phase B で再評価) |
| 5 | A-4 Codex review gap clearance | PR #141-#146 を Codex usage 復帰後に `@codex review` トリガー、検出 finding は別 PR で fix。本 plan land と independent |

### 2.1.1 ADR-010 §11 OQ #8 / #9 解決方針 (Round 1 P2-2 反映)

ADR-010 §11 OQ #8 は **two-option** で残されている — 「ADR-011 で wire するか、本 ADR P3 (invariants_held) と並行で別 phase として扱うか」。本 plan は **(a) ADR-011 Phase A wire** を採用、その理由:

| 選択肢 | 評価 |
|---|---|
| **(a) ADR-011 Phase A で wire** ★ 採用 | A-2 (sessionId source finalize) と密結合 — `include=["causal"]` の caused_by projection は **session-scoped working memory** の発端で、session_id 解決経路 (A-2) なしには `multi:disabled` sentinel guard が実 production で機能しない。ADR-011 は Cognitive Memory Extension の責務範囲、causal projection は session-scoped memory の最初期形態として ADR-011 が一貫管理する方が責務境界クリア。trunk 5 構造的 contract #3 (sentinel runtime closed loop) を ADR-011 で実 transport binding に置換する整合とも一致 (`docs/walking-skeleton-expansion-plan.md` §6.1 #4) |
| (b) ADR-010 P3 (invariants_held) と並行で別 phase | ADR-010 P3 は invariants_held projection で別軸の view extension、caused_by wiring とは独立な enrichment。phase 並走は実装軸では成立するが、本質的に「ADR-010 P3 (envelope 拡張) と ADR-011 (cognitive memory) の責務境界が曖昧化」する。残 8 query tool の causal projection は session_id (= cognitive memory の root identifier) なしに正しく機能しないため、ADR-011 の責務として一貫管理する方が長期保守性が高い |

OQ #9 (HISTORY_BUFFER_CAPACITY=8 + run_macro long macro evict) は本 plan **A-3 で compound commit boundary 概念導入** で解決 (§4.3)、OQ #8 と同じ一貫性論理 (causal continuity / session-scoped memory) で扱える。

ADR-010 §11 OQ #8 / #9 は本 plan A-1 / A-3 land 時に resolved 化 (§9.3 carry-over 解消 mark)。

### 2.2 設計の核

**A-1 + A-2 + A-3 はそれぞれ独立 PR** に分離可能で、worktree 並走対象 (CLAUDE.md §3.4 Max 20x 並走戦略整合)。A-4 は user 判断 + Codex usage 復帰待ちで本 plan land と independent。

各 PR は trunk lock layer 改変ゼロ (engine-perception / l1_capture / l3_bridge / engine-perception 触らず)、L4 envelope + L5 wrapper のみの改変で完結する。

---

## 3. Architecture

### 3.1 5 層との位置づけ

```
┌─────────────────────────────────────────────────────────┐
│ L5: MCP Tool Surface                                     │
│     A-1: 8 query tool registration site で               │
│            genericQueryCausedByProjector wire            │
│     A-2: registration site で sessionId getter wire      │
├─────────────────────────────────────────────────────────┤
│ L4: Cognitive Projection + Envelope Assembly             │
│     A-1: genericQueryCausedByProjector を _envelope.ts に│
│            extract (desktopStateCausedByProjector 生体化)│
│     A-2: getMcpTransportSessionId() stub を実装に置換    │
│     A-3: ToolCallEvent.isCompoundBoundary + eviction     │
│            保護ロジック                                   │
├─────────────────────────────────────────────────────────┤
│ L3: Compute (IVM)                          ← 改変ゼロ    │
├─────────────────────────────────────────────────────────┤
│ L2: Storage (MVCC)                         ← 改変ゼロ    │
├─────────────────────────────────────────────────────────┤
│ L1: Capture (event ring buffer)            ← 改変ゼロ    │
└─────────────────────────────────────────────────────────┘
```

trunk lock layer (`crates/engine-perception/**/*.rs` / `src/l1_capture/**/*.rs` / `src/l3_bridge/**/*.rs` / `src/engine/perception/**/*.ts`) **すべて触らない**。expansion-pr-guard.yml + check-expansion-disjoint.mjs の 2 重 pin で enforce 済。

### 3.2 識別子フロー (A-2 finalize 後)

```
MCP request 受信
    │
    ▼
RequestContext から session_id 取得 (MCP SDK)
    │
    ├── transport が session_id 提供 → transportSessionId 採用
    ├── transport 提供なし + multi-session detect → "multi:disabled" sentinel
    └── transport 提供なし + single-session prototype → "default" fallback
    │
    ▼
L5 wrapper の getSessionId に伝播
    │
    ▼
causedByProjector(args, sessionId) 呼び出し
    │
    ├── sessionId === "multi:disabled" → undefined 返却 (skip caused_by)
    └── それ以外 → buildCausedBy + buildBasedOn を呼び出し
```

### 3.3 A-3 compound commit boundary 構造

```
run_macro 呼び出し (steps = [s1, s2, ..., s9])
    │
    ▼
makeCommitWrapper("run_macro") wraps handler
    │
    ├── pushHistoryStarted({ ..., isCompoundBoundary: true })  ★ A-3 新規 flag
    │
    ├── handler 実行 (内部で各 step が自前 makeCommitWrapper 経由で push)
    │     ├── s1 → pushHistoryStarted({ ..., isCompoundBoundary: false })
    │     ├── s2 → pushHistoryStarted({ ..., isCompoundBoundary: false })
    │     ├── ...
    │     └── s9 → pushHistoryStarted({ ..., isCompoundBoundary: false })
    │
    └── pushHistoryCompleted (outer run_macro 完了)

ring buffer 状態 (capacity = 8、9-step macro = outer + s1..s9 = 10 push、2 件 overflow):
    [s2, s3, s4, s5, s6, s7, s8, s9]                    ← 旧挙動: outer + s1 が連続 evict、最新 step 8 件のみ
    [outer run_macro★, s3, s4, s5, s6, s7, s8, s9]      ← 新挙動: outer は boundary 保護、s1 + s2 が連続 FIFO evict
                       ↑
                       isCompoundBoundary flag で eviction skip
```

`buildCausedBy` の `your_last_action` projection は **boundary preserved outer event** を優先参照、orchestration boundary が ring 内に保たれる。

注意点:
- ring effective capacity は boundary 保護分だけ実質減る (boundary 1 件 → effective = 7)。複数同時 outer (run_macro 内 run_macro) は **本 plan では non-goal** (現行 macro.ts の `TOOL_REGISTRY` から run_macro 除外で recursion 防止済、SSOT line: `macro.ts:354` TOOL_REGISTRY 除外定義 + `macro.ts:404-409` runtime guard。`macro.ts:509-511` は `runMacroRegistrationHandler` docstring 内の referencing comment で defining truth ではない)
- boundary entry が wallclockEndMs 未確定で長期保持されると `buildCausedBy` の monotonic timeout (b) で skip される — 「outer 完了済 + step が後続」を pin する unit test 必須

---

## 4. Phase A 詳細

### 4.1 A-1: 8 query tool caused_by wiring

#### 4.1.1 設計

`desktop-state.ts:637-732` の `desktopStateCausedByProjector` を `_envelope.ts` に **`genericQueryCausedByProjector`** として extract し、以下 8 query tool の registration site で wire:

| # | tool | registration file | 配線方針 |
|---|---|---|---|
| 1 | browser_overview | browser.ts | 既存 `makeQueryWrapper` call site で `causedByProjector + getSessionId` 追加 |
| 2 | browser_locate | browser.ts | 同上 |
| 3 | browser_search | browser.ts | 同上 |
| 4 | screenshot | screenshot.ts | 同上 |
| 5 | server_status | server-status.ts | 同上 |
| 6 | wait_until | wait-until.ts | 同上 |
| 7 | workspace_snapshot | workspace.ts | 同上 |
| 8 | desktop_discover | desktop-register.ts | 既存 `fetchMeta: fetchEnvelopeMeta` (S4 でも配線済) を保持しつつ `causedByProjector: genericQueryCausedByProjector` + `getSessionId: defaultQuerySessionId` を追加 (plan 起草時の `desktopActSessionId` 言及は誤記、`desktopActSessionId` は `desktop_act` commit-axis の lease.viewId base resolver。`desktop_discover` は query で lease を持たないため `defaultQuerySessionId` 経路が正しい — A-1 PR #156 Round 2 P2-1 NEW 反映 2026-05-07) |

#### 4.1.2 共通 projector 抽出

`desktopStateCausedByProjector` の **focus / dirty rect / latestEventId / queryWallclockMs 4 軸 ViewSnapshot 構築** はどの query tool でも同じ shape で使える (tool 固有 args 依存なし、L3 view 経由のみ)。

抽出後の signature:

```typescript
// _envelope.ts に新設
export const genericQueryCausedByProjector = async (
  _args: unknown,
  sessionId: string,
): Promise<{ causedBy?: CausedByShape; basedOn?: BasedOnShape; forceDegraded?: boolean } | undefined> => {
  if (sessionId === "multi:disabled") return undefined;
  if (!nativeL1 || typeof nativeL1.l1GetCaptureStats !== "function") {
    return { forceDegraded: true };
  }
  // focus / dirtyRectsByMonitor / latestEventId / queryWallclockMs 4 軸 ViewSnapshot 構築
  // (desktopStateCausedByProjector lines 661-727 と同等)
  // ...
  return {
    causedBy: buildCausedBy(sessionId, snapshot),
    basedOn: buildBasedOn(sessionId, snapshot),
  };
};
```

`desktop-state.ts` の `desktopStateCausedByProjector` は `genericQueryCausedByProjector` への delegating fn 化 (backward compat 維持)。

#### 4.1.3 PR 単位

8 tool を **1 PR で mechanical コピー** (worktree 不要、各 tool registration 1 行追加 + projector wire のみ)。trunk PR #112 shared registration handler pattern と同型。

#### 4.1.4 acceptance

- 8 query tool 全てで `include=["causal"]` 受け付け、`caused_by` / `based_on` を projection (commit が直前にあった場合)
- `getMcpTransportSessionId() === undefined` (現状 stub) でも `getSessionId` default `"default"` で sentinel guard が壊れない
- unit test: 各 tool で `include=["causal"]` 後の commit (例: mouse_click) との causal projection を pin
- envelope size: `include=causal` で +1KB 以内 (ADR-010 §5.6.1)

#### 4.1.5 既存 SSOT との bit-equal sync

`desktopStateCausedByProjector` を `genericQueryCausedByProjector` に extract する際、既存 4 軸 ViewSnapshot 構築ロジックの **意味的不変性** を pin:
- focus view fetch 失敗 → `null` 返し、`produced_changes` で「no focus observed」表現
- dirty rect view 失敗 → `dirtyRectsByMonitor` 空 Map 返し
- L1 stats 失敗 → `latestEventId: undefined`、frontier check skip + monotonic timeout (b) fallback
- `forceDegraded` 経路は 8 tool 全てで生かす (`confidence: degraded` projection)

CLAUDE.md §3.1 (複数表 fact 整合): `desktopStateCausedByProjector` を全削除する場合、`docs/adr-010-p1-s5-plan.md` §2.5 / `desktop-state.ts:734-793` (S5 sessionId resolver) の references を grep で sync 確認。

### 4.2 A-2: sessionId source finalize

#### 4.2.1 設計

MCP SDK (`@modelcontextprotocol/sdk`) の `RequestContext` API から session_id を取得する経路を実装。現行 stub `getMcpTransportSessionId()` (desktop-state.ts:753) は無条件 `undefined` 返却で sentinel branch (desktop-state.ts:790、`desktopStateGetSessionId` 内) は dead code (CodeQL #109、PR #120 で "Won't fix" dismiss、ADR-011 で生かす設計)。

#### 4.2.2 取得経路の選択肢

| option | 経路 | 評価 |
|---|---|---|
| **(a)** MCP SDK `RequestContext.session.id` 直接参照 | `server.tool` handler 内で context arg 受け取り | SDK API support 確認必須 |
| **(b)** McpServer instance に `currentSessionId` AsyncLocalStorage で注入 | request 受信時に context 値 set、handler 内で `AsyncLocalStorage.getStore()` 取得 | Node.js standard 経路、SDK 改変不要 |
| **(c)** transport (stdio / HTTP) layer で direct 取得 | transport 種別ごとに別 resolver | stdio は単一 session 前提で undef、HTTP はヘッダ経由 |

**推奨**: (b) AsyncLocalStorage 経由 — Node.js standard、SDK API 不変、transport 種別 agnostic。

#### 4.2.3 multi-session detection logic

`_isSingleSessionPrototype()` (desktop-state.ts:751) は現状 stub `() => true`、test seam で `false` pin 可。ADR-011 finalize 後の挙動:

```typescript
// 仮実装案
function isSingleSessionPrototype(): boolean {
  // 起動時に env / config で固定:
  //   DESKTOP_TOUCH_SESSION_MODE = "single" | "multi" | "auto" (default "auto")
  // - "single" → true (現行 single-LLM-client deploy)
  // - "multi" → false (multi-session、sentinel branch active)
  // - "auto" → MCP transport (stdio / HTTP / WebSocket) から判定
  //     stdio = single, HTTP/WS = multi-capable
  const mode = process.env.DESKTOP_TOUCH_SESSION_MODE ?? "auto";
  if (mode === "single") return true;
  if (mode === "multi") return false;
  // auto: transport 経由判定 (実装は MCP SDK API に依存)
  return resolveTransportMode() === "stdio";
}
```

#### 4.2.4 PR 単位

A-2 は **1 PR で完結**:
- AsyncLocalStorage 注入経路実装 (`src/server/index.ts` か entry 直下)
- `getMcpTransportSessionId()` stub を実装置換
- `_isSingleSessionPrototype()` を env / transport-aware logic に
- `desktop-state.ts:768-793` の `desktopStateGetSessionId` は変更不要 (上記 stub 置換が透過)

worktree 並走可、A-1 と independent (`_envelope.ts` への touch 重複は merge order で吸収)。

#### 4.2.5 acceptance

- stdio transport で `getMcpTransportSessionId()` が transport session id を返す (or `undefined` のまま、env 設定次第)
- HTTP transport で複数 session が来たとき各 session id が異なる
- env `DESKTOP_TOUCH_SESSION_MODE=multi` で `_isSingleSessionPrototype() === false` → `multi:disabled` sentinel が生きる
- unit test: 既存 `_setSingleSessionPrototypeForTest` / `_resetSingleSessionPrototypeForTest` test seam を **削除しない** (Round 2 P3 Opus #2 で導入、CodeQL alert 用 protected stub の役割保持)
- regression: 既存 desktop_state caused_by test で session_id 解決経路が壊れない

### 4.3 A-3: run_macro compound commit boundary

#### 4.3.1 設計

`ToolCallEvent` interface (`_envelope.ts:920-943`) に **`isCompoundBoundary?: boolean`** field 追加、`evictHistoryIfNeeded` (line 997-1014) と production path の ring `events.shift()` (line 1045 内 `pushHistoryStarted` + line 1083 内 `pushHistoryCompleted` 周辺、`evictOldestNonBoundary` 呼び出しに置換) で boundary entry の eviction を skip する logic 追加。`_seedHistoryForTest` (line 983) は test-only seam で boundary 保護対象外、production path 改変では touch しない (test seed は boundary なし前提、`evictOldestNonBoundary` 適用不要)。

#### 4.3.2 ToolCallEvent 拡張

```typescript
export interface ToolCallEvent {
  // 既存 fields ...
  /** True when this entry represents a compound commit boundary
   *  (e.g. run_macro outer event). Boundary entries are protected
   *  from FIFO eviction so causal continuity is preserved across
   *  long macros (ADR-011 A-3). Default: false.  */
  isCompoundBoundary?: boolean;
}
```

`pushHistoryStarted` の引数に `isCompoundBoundary?: boolean` 追加、`run_macro` の `makeCommitWrapper` options で `isCompoundBoundary: true` を渡す経路新設。

#### 4.3.3 makeCommitWrapper API 拡張

```typescript
// _envelope.ts CommitWrapperOptions
export interface CommitWrapperOptions {
  // 既存 ...
  /** Mark this commit as a compound commit boundary — its ring entry
   *  is protected from FIFO eviction so long macros can preserve
   *  orchestration boundary in causal projection (ADR-011 A-3). */
  isCompoundBoundary?: boolean;
}
```

`runMacroRegistrationHandler` (macro.ts:515-522) で `isCompoundBoundary: true` 追加。

#### 4.3.4 eviction skip logic

```typescript
// _envelope.ts evictHistoryIfNeeded + ring.events.shift() 周辺
function evictOldestNonBoundary(events: ToolCallEvent[]): void {
  // FIFO evict だが boundary は skip
  const idx = events.findIndex(e => !e.isCompoundBoundary);
  if (idx >= 0) {
    events.splice(idx, 1);
  } else {
    // 全 entry が boundary (異常ケース、複数 outer 同時) → 旧 FIFO
    events.shift();
  }
}
```

`pushHistoryStarted` / `pushHistoryCompleted` 内の `while (ring.events.length > ring.capacity) ring.events.shift()` を `evictOldestNonBoundary(ring.events)` 呼び出しに置換。

#### 4.3.5 `buildCausedBy` projection 改修 (Round 2 P1 NEW-1 反映)

eviction skip だけでは acceptance (`your_last_action = outer run_macro event`) は達成できない。既存 `_envelope.ts:1095` の `lastEvent` 選択ロジックは ring 末尾 1 件のみ参照、boundary preserved outer event が ring 先頭に居て step が末尾にある場合 `lastEvent = 最終 step` となり要求挙動が成立しない。

#### 4.3.5.1 既存ロジック (改修対象)

```typescript
// _envelope.ts:1087-1120 buildCausedBy 既存 impl
export function buildCausedBy(sessionId, viewSnapshot, options): CausedByShape | undefined {
  const ring = _historyBuffers.get(sessionId);
  if (!ring || ring.events.length === 0) return undefined;
  ring.lastAccessMs = _historyClock();
  const lastEvent = ring.events[ring.events.length - 1];  // ★ 改修対象 (line 1095)
  if (lastEvent.wallclockEndMs === undefined) return undefined;
  // ... monotonic timeout (line 1099-1102) + frontier check (line 1105-1112) は変更不要
  return { your_last_action: ..., ... };
}
```

#### 4.3.5.2 新ロジック: boundary 優先 + 完了済 entry 探索 + 末尾 fallback

```typescript
// 改修後の lastEvent 選択
let lastEvent: ToolCallEvent | undefined;

// (1) 完了済 boundary entry を優先選択 (LIFO: ring 内に複数 boundary が居る場合は末尾)
//     wallclockEndMs 未確定 boundary は skip (long-running outer 中、step 後続未発火)
for (let i = ring.events.length - 1; i >= 0; i--) {
  const e = ring.events[i];
  if (e.isCompoundBoundary === true && e.wallclockEndMs !== undefined) {
    lastEvent = e;
    break;
  }
}

// (2) 完了済 boundary 不在: 既存挙動 (末尾 1 件参照) で backward compat
if (lastEvent === undefined) {
  lastEvent = ring.events[ring.events.length - 1];
}

// (3) wallclockEndMs 未確定 → commit in-flight skip (既存挙動維持)
if (lastEvent.wallclockEndMs === undefined) return undefined;
```

#### 4.3.5.3 ロジック解説

- **(1) 完了済 boundary 優先**: ring 内に複数 boundary が居る場合 (本 plan non-goal だが degraded fallback として) は **末尾 boundary (LIFO)** を選択 — 最新の orchestration が anchor として最も causal continuity を表現する
- **(2) backward compat**: boundary 不在 (= 通常の commit のみ) では既存挙動維持、step ≤ 8 ケースで挙動不変 (regression なし)
- **(3) commit in-flight skip**: 既存 line 1096 の `wallclockEndMs === undefined` skip は維持、選択された lastEvent が完了済かを確認
- **monotonic timeout (b) + frontier check (a) は変更不要**: 既存 `_envelope.ts:1099-1102` + `1105-1112` の guard は selected `lastEvent` に対して同じ semantics で適用される

#### 4.3.5.4 `buildBasedOn` の整合 (Round 2 P2 Codex line 1073 反映済の同型 sweep)

`buildBasedOn` (`_envelope.ts:1122-` 周辺) は `buildCausedBy` と同じ causal window guard を持つ (Round 2 P2 Codex line 1073 反映)。boundary 優先 lastEvent 選択は **`buildBasedOn` でも同型適用** が必要 (`based_on.events` も outer event を anchor として返す)。実装時に **`buildCausedBy` と `buildBasedOn` 両者で lastEvent 選択ヘルパ関数を共有** する設計を推奨 (DRY + bit-equal sync)。

#### 4.3.6 capacity 設計判断

- 現行 `HISTORY_BUFFER_CAPACITY = 8` 維持 (Phase B で working memory 全体設計時に再評価)
- run_macro `MAX_STEPS = 50` (`macro.ts:375` Zod `.max(50)` SSOT、description `macro.ts:529` で「Max 50 steps」明記) は capacity 8 より大きいので、step が capacity を超えるケースは依然発生 — boundary 保護で outer は preserve、step は通常 FIFO
- 複数同時 outer (現行 `TOOL_REGISTRY` から run_macro 除外で発生不可、`macro.ts:354` 「run_macro is intentionally excluded → prevents recursion」+ `macro.ts:404` runtime guard) は non-goal、検出時は `evictOldestNonBoundary` の fallback FIFO で degraded 動作

#### 4.3.7 PR 単位

A-3 は **1 PR で完結**:
- `_envelope.ts` の `ToolCallEvent` + `pushHistoryStarted` + `evictHistoryIfNeeded` 拡張
- `_envelope.ts` の `CommitWrapperOptions.isCompoundBoundary` API 追加
- **`_envelope.ts:1095` の `buildCausedBy` 内 lastEvent 選択ロジック拡張** (boundary 優先 + 完了済 entry 探索 + 末尾 fallback、§4.3.5)
- **`_envelope.ts:1122-` 周辺の `buildBasedOn` 同型 lastEvent 選択拡張** (§4.3.5.4、`buildCausedBy` と共有ヘルパ)
- `macro.ts:515-522` の `runMacroRegistrationHandler` で flag 設定
- unit test: 9-step macro で outer event が ring に preserved + step は FIFO evict、`buildCausedBy` / `buildBasedOn` の `your_last_action` / `events` が outer event を anchor として返すことを pin

#### 4.3.8 acceptance

- 9-step run_macro 後の `desktop_state(include=["causal"]).caused_by.your_last_action` が outer run_macro event を返す (現行 caveat 挙動 = step に collapse は解消)
- step 数が capacity 8 以下のケースは挙動不変 (regression 防止)
- 複数 boundary 同時の degraded fallback で panic / 無限ループしない (`findIndex` fallback test)
- envelope size 影響: なし (既存 entry の field 増のみ、payload 不変)

#### 4.3.9 §1.5 causal continuity 整合確認

ADR-010 §1.5 (Tool Surface 不変原則) + §4.2 (Causal Continuity) 観点:
- `your_last_action` が outer run_macro として返ることは **causal continuity 強化**
- step 単位の詳細は現行通り inner event 群 (boundary 保護対象外) で表現、必要なら `include=["episodic:N"]` (Phase B) で expose
- 統合書 §6 worked example の causal trail 表記と整合 (commit boundary marker としての run_macro)

### 4.4 A-4: PR #141-#146 Codex review gap clearance

#### 4.4.1 設計

PR #141-#146 (browser_locate / browser_search / wait_until / workspace_snapshot / server_status / run_macro、Codex usage limit 中の Opus 単独 merge) を Codex usage 復帰後に **`@codex review` トリガーで振り返り review**。

#### 4.4.2 trigger 条件

User 判断項目:
- Codex usage 復帰後の任意 timing
- 本 plan の A-1 / A-2 / A-3 land と independent
- `memory/feedback_pr_review_loop_merge_criteria.md` 「Codex 応答なしなら Opus 単独 OK」基準で merge は妥当だったが、CLAUDE.md §3.3 Step 2「production code 改修 PR は Codex 必須」遡及 review 機会を設ける

#### 4.4.3 review 対象

各 PR について:
- Codex 軸 (構造 / スキーマ / API contract regression) で finding 検出
- finding は **別 PR で fix** (本 plan land と independent)
- Codex P1 finding なし → 振り返り完了 mark

#### 4.4.4 acceptance

- 6 PR について Codex 振り返り review 完了
- 検出 P1 finding は別 PR で fix land
- `docs/walking-skeleton-expansion-plan.md` §6.1 #2 を resolved 化

#### 4.4.5 PR 単位

A-4 自体は **PR を作らない** (review コメントのみ)。検出 finding がある場合のみ別 PR 起票。本 plan の A-1 / A-2 / A-3 と independent、user 判断で trigger。

---

## 5. Phase B preview (本 plan scope 外)

CoALA 全体 (working / episodic / semantic / procedural memory) を扱う Phase B は別 sub-plan `docs/adr-011-phase-b-coala-plan.md` で起草予定。Phase A wire 完了後に着手。

| memory type | 想定 view / API | 想定 phase |
|---|---|---|
| Working memory | `current_state` (recent N event compact) → `include=["working:N"]` | Phase B-1 |
| Episodic memory | `tool_call_history` (history buffer expose) → `include=["episodic:N"]` | Phase B-2 |
| Semantic memory | `learned_ui_pattern` (page graph) → 別 view 設計、ADR-011 Phase B-3 |
| Procedural memory | `successful_macros` (fused action) → 別 view 設計、ADR-011 Phase B-4 |

Phase B 着手 trigger は Phase A wire 完了 + ADR-010 P3-P5 進行状況に依存。

---

## 6. Acceptance criteria

| Phase A 項目 | 完了基準 |
|---|---|
| **A-1** | 8 query tool 全てで `include=["causal"]` 動作、causal projection 空でない (commit 直前ありの場合)、envelope size +1KB 以内、unit test pin |
| **A-2** | `getMcpTransportSessionId()` が transport session id 返却 (or `undefined` だが env で制御可)、`_isSingleSessionPrototype()` 実装置換、`multi:disabled` sentinel が production で active 化可、既存 test seam 維持 |
| **A-3** | 9-step run_macro 後の `your_last_action` が outer run_macro event、step ≤ 8 ケース regression なし、`evictOldestNonBoundary` fallback test pin、**effective capacity = `HISTORY_BUFFER_CAPACITY` − boundary entry 数** (boundary 1 件保護時 effective = 7) を unit test で pin、9-step macro で outer 1 + step 7 = 8 ring 充填、後続 step が乗り切らない場合は古い step が FIFO evict |
| **A-3 (compound boundary 完了 invariant)** | outer 完了済 + step 後続のケースで `buildCausedBy` の `your_last_action = outer run_macro event` を返却 (ring 末尾は最終 step だが boundary preservation により outer が causal projection の anchor、Round 1 P3-2 反映) |
| **A-4** | 6 PR Codex 振り返り review 完了、P1 finding は別 PR で fix land |
| **横断** | trunk lock layer 改変ゼロ (expansion-pr-guard.yml + check-expansion-disjoint.mjs pass) |
| **横断** | ADR-010 §11 OQ #8 / #9 を resolved 化 (本 ADR-011 Phase A 完了で closure) |
| **横断** | walking-skeleton-expansion-plan §6.1 #1 / #2 / #3 / #4 全て resolved (ADR-011 Phase A 完了 mark) |

---

## 7. Risks

| # | リスク | 影響 | 軽減策 |
|---|---|---|---|
| 1 | `genericQueryCausedByProjector` extract で `desktopStateCausedByProjector` の意味的挙動 drift | High | delegating fn 化 + 既存 desktop_state test 全 pass を pin、§4.1.5 bit-equal sync sweep |
| 2 | MCP SDK の `RequestContext` API が session_id 提供しない | High | AsyncLocalStorage 経由 (option b) で SDK 不変回避、env override で逃げ道 |
| 3 | `isCompoundBoundary` flag 追加で既存 ring eviction logic に regression | Medium | `evictOldestNonBoundary` の fallback test (全 entry boundary ケース) + step ≤ 8 regression test |
| 4 | A-4 Codex 振り返り review で multiple P1 finding 検出 → ADR-011 timeline 圧迫 | Medium | A-4 は本 plan land と independent、検出 finding は別 PR、本 plan は A-1/A-2/A-3 で acceptance 達成可 |
| 5 | `multi:disabled` sentinel が production で誤動作 (single-session 環境で発火) | High | `DESKTOP_TOUCH_SESSION_MODE=auto` default で stdio = single-session 判定、env override で確実な制御 |
| 6 | PR #141-#146 Codex 振り返り review で Codex usage が再度 limit に当たる | Low | A-4 trigger を user 判断に委ね、本 plan land をブロックしない |
| 7 | A-3 boundary 保護で `wallclockEndMs` 未確定 boundary (long-running macro 中) が `buildCausedBy` の monotonic timeout で skip | Medium | unit test で「outer 完了済 + step が後続」ケースを pin、boundary が完了済かつ step 後続のみ projection 対象 |

---

## 8. Open Questions

| # | 質問 | 検討タイミング |
|---|---|---|
| 1 | A-2 で AsyncLocalStorage 経路採用するか、SDK API 直接参照か (option a vs b) | A-2 着手前、MCP SDK API 確認後 |
| 2 | `DESKTOP_TOUCH_SESSION_MODE=auto` 時の transport detect 経路 (stdio / HTTP / WS 判定) | A-2 着手時、MCP SDK transport API 経由で確認 |
| 3 | A-3 boundary 保護で「複数同時 outer」(将来 nested run_macro 解禁時) の挙動仕様 | Phase B 着手時、`TOOL_REGISTRY` recursion 防止解除と同時 |
| 4 | `genericQueryCausedByProjector` の query tool 固有 enrichment (例: screenshot 画像取得直後の causal は dirty rect 状態を強調) は Phase B か A-1 か | A-1 着手前、unit test で挙動確認後 |
| 5 | A-4 Codex 振り返り review で検出 finding を「ADR-011 Phase A 範囲内」とするか「独立 PR」とするか | A-4 trigger 後、finding 内容次第で user 判断 |
| 6 | Phase B 着手 timing は ADR-010 P3-P5 どれと並走するか、または Phase A 完了直後の sequential か | Phase A 完了時、user 判断 |
| 7 | A-3 boundary 保護 entry が `buildCausedBy` の monotonic timeout (`_envelope.ts:1098-1102` `nowMonotonic - lastEvent.monotonicStartMs > timeoutMs`) を超えても projection 対象とすべきか — 既存 timeout は「stale な causal trail を skip」設計、boundary 保護 entry は「orchestration boundary preserve」目的で目的が異なる。Sonnet 実装時に「timeout 値だけ拡張」して既存挙動を破壊するリスク (CLAUDE.md §3.2 carry-over scope shrink、Round 2 P3-C 反映)。**選択肢: (a) boundary entry は timeout 例外、orchestration boundary 保持優先 / (b) 通常 timeout 適用、長期保持は stale 判定で skip / (c) outer 完了済 (`wallclockEndMs` 確定) ケースのみ timeout 例外、未完了は skip** | A-3 着手時、unit test 設計と同時 |

---

## 9. Implementation phases (PR breakdown)

### 9.1 PR 着手順序

| 順 | PR | scope | `_envelope.ts` touch 領域 | review 強度 (CLAUDE.md §3.3 Step 0) |
|---|---|---|---|---|
| 1 | **A-1: 8 query tool causal wiring** | `_envelope.ts` extract (`genericQueryCausedByProjector`) + 8 file registration wire + unit test | `genericQueryCausedByProjector` 新設 (新規 export) | Opus 必須 + Codex 推奨 (production code 改修) |
| 2 | **A-3: run_macro compound commit boundary** | `ToolCallEvent.isCompoundBoundary` + `evictOldestNonBoundary` + `buildCausedBy` / `buildBasedOn` lastEvent 選択拡張 + `runMacroRegistrationHandler` flag + unit test | `ToolCallEvent` interface (line 920-943) + `pushHistoryStarted` (line 1016-1047) + `evictHistoryIfNeeded` (line 997-1014) + `CommitWrapperOptions` 拡張 + **`buildCausedBy` (line 1087-1120) / `buildBasedOn` (line 1122-) lastEvent 選択ロジック (§4.3.5)** | Opus 必須 + Codex 必須 (production code 改修) |
| 3 | **A-2: sessionId source finalize** | AsyncLocalStorage 注入 + `getMcpTransportSessionId` 実装置換 + env mode + unit test | `getSessionId` default (line 1380, 1598) は変更不要、改変は `desktop-state.ts:753, 768-793` 内 | Opus 必須 + Codex 必須 (production code 改修、API contract 軸重要) |
| 4 | **A-4: Codex 振り返り review** | PR を作らない (review コメントのみ) | (なし) | review only、user 判断 trigger |

#### 9.1.1 Merge order recommendation (Round 1 P3-3 反映)

PR 着手順 = **A-1 → A-3 → A-2** (上記表の順)。理由:

- **A-1 → A-3**: A-1 は `_envelope.ts` の **新規 export 追加** のみ (`genericQueryCausedByProjector`)、`ToolCallEvent` / `pushHistoryStarted` / `evictHistoryIfNeeded` / `CommitWrapperOptions` への touch なし。A-3 は **既存 interface 拡張** で改変領域広い。A-1 を先に land すると A-3 の rebase は trivial (新規 export 行を skip するだけ)
- **A-3 → A-2**: A-3 は `_envelope.ts` の history buffer / commit wrapper layer に改変、A-2 は `desktop-state.ts` 内 stub 置換が主で `_envelope.ts` の `getSessionId` default は変更不要。A-3 land 後の A-2 rebase も trivial
- A-1 と A-3 は **`_envelope.ts` 内 disjoint section** (export 追加 vs interface 拡張) のため worktree 並走可、ただし merge は order 固定推奨で rebase 簡単化
- A-2 は `desktop-state.ts` 主改変で他 PR と file 衝突しないため、worktree 並走で最後に land する場合も rebase 容易

A-4 は本 plan land と independent (review コメントのみ、PR 作らない) のため merge order に含めない。

### 9.2 PR review loop (CLAUDE.md §3.3 Step 1-5)

各 PR で:

1. **Step 1**: PR 作成直後、Opus phase-boundary review
   - 対象 file full read + 関連 SSOT (本 plan + ADR-010 + walking-skeleton-expansion-plan) full read
   - §3.1 (複数表 fact 整合) sweep
   - §3.2 (carry-over scope shrink) sweep
   - Lesson 1-4 sweep (causal window / compile-time guard / 順序矛盾 / numeric count sync)
   - P1 / P2 / P3 分類 + line citation、< 800 words
2. **Step 2**: Codex re-review (`@codex review` PR コメント trigger)
3. **Step 3**: 反復 (P1 ゼロ化まで)
4. **Step 4**: User reviewer 補正 window (最終防御層)
5. **Step 5**: Merge 判断は user

### 9.3 carry-over 解消 mark

各 PR land 時 (entry 順 = §9.1.1 merge order = land 時系列、Round 2 P3 NEW-3 反映):

- (merge 順 1 番目) **A-1** land → `walking-skeleton-expansion-plan §6.1 #1` resolved + ADR-010 §11 OQ #8 resolved
- (merge 順 2 番目) **A-3** land → `walking-skeleton-expansion-plan §6.1 #3` resolved + ADR-010 §11 OQ #9 resolved
- (merge 順 3 番目) **A-2** land → `walking-skeleton-expansion-plan §6.1 #4` resolved
- (本 plan land と independent) **A-4** 完了 → `walking-skeleton-expansion-plan §6.1 #2` resolved

全 4 項目 resolved 時、本 plan を **Status: Completed v1.0** に flip。

---

## 10. Related artifacts

- 本 plan: `docs/adr-011-cognitive-memory-extension.md`
- 親 ADR: `docs/adr-010-presentation-layer-self-documenting-envelope.md` §6 / §11 OQ #8 #9
- carry-over source: `docs/walking-skeleton-expansion-plan.md` §6.1
- sentinel runtime closed loop: `docs/adr-010-p1-s5-plan.md` §1.1 E-2 + §2.4
- 統合書: `docs/architecture-3layer-integrated.md` §4 (識別子) + §16 (SSOT 整合)
- Layer constraints: `docs/layer-constraints.md` §5 / §6
- Phase B (起草予定): `docs/adr-011-phase-b-coala-plan.md`
- 既存実装 SSOT (line ref drift を避けるため grep keyword 推奨、§1.5 注記参照):
  - `src/tools/_envelope.ts` history buffer + ring + eviction: `interface ToolCallEvent` / `_seedHistoryForTest` (test seam、boundary 保護対象外) / `evictHistoryIfNeeded` (TTL + LRU) / `evictOldestNonBoundary` (A-3 production overflow) / `selectLastEventForCausalProjection` (A-3 anchor 選択共有) / `pushHistoryStarted` (production FIFO + boundary flag)
  - `src/tools/_envelope.ts` `getSessionId` default 両 axis (`makeCommitWrapper` + `makeQueryWrapper` 内)
  - `src/tools/_envelope.ts` `CommitWrapperOptions` (A-3 で `isCompoundBoundary` 追加) / `QueryWrapperOptions` / `makeCommitWrapper` (A-3 で `l1.pushStarted` 伝播追加) / `makeQueryWrapper`
  - `src/tools/_envelope.ts` `L1ToolCallStartedArgs` (A-3 で `isCompoundBoundary` 追加) / `CommitL1Emitter` / `defaultL1Emitter`
  - `src/tools/desktop-state.ts` causedByProjector + sessionId resolver + registration (`desktopStateCausedByProjector` / `desktopStateGetSessionId`)
  - `src/tools/macro.ts` run_macro registration + A-3 caveat (`runMacroRegistrationHandler` の `isCompoundBoundary: true` 配線、`TOOL_REGISTRY` 除外定義 + runtime guard)

---

## Appendix A: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Drafted v0.1 | 2026-05-07 | Claude (Sonnet) | 初稿起草。Phase A scope = expansion phase carry-over 4 項目 (A-1 caused_by wiring / A-2 sessionId source finalize / A-3 run_macro compound commit boundary / A-4 Codex review gap clearance) + ADR-010 §11 OQ #8 #9 wire 完了、Phase B (CoALA 全体) は別 sub-plan。3 PR (A-1 / A-2 / A-3) + A-4 review-only breakdown + acceptance criteria + risks + OQ + carry-over 解消 mark。Opus phase-boundary review 未実施。(v0.5 で Round 2 P3 NEW-1 反映: 旧記述「9 PR breakdown」typo 訂正、実態は 3 PR + A-4 review コメント) |
| Drafted v0.2 | 2026-05-07 | Claude (Sonnet) | Round 1 Opus phase-boundary review (agentId ac8bbc8cd603b38d7、Conditionally Approved) findings 反映: P2-1 line citation drift (§1.3 + §4.2.1 で `getMcpTransportSessionId` line range を `753` 定義 / `768-793` resolver / `790` sentinel branch に bit-equal sync)、P2-2 §2.1.1 新設で ADR-010 §11 OQ #8 two-option 議論明記 ((a) Phase A wire vs (b) ADR-010 P3 並行、(a) 採用理由を session-scoped working memory + sentinel runtime closed loop 整合で論証)、P2-3 §4.3.5 numeric count concrete 化 (`MAX_STEPS = 50` を `macro.ts:375` Zod `.max(50)` SSOT + `macro.ts:529` description に line citation)、P3-1 TOOL_REGISTRY recursion 防止 line citation (`macro.ts:354` 除外コメント + `macro.ts:404` runtime guard) を §4.3.5 で同時反映、P2-4 §6 acceptance に effective capacity 表現上昇 (boundary entry 数で減算 + 9-step macro 充填例)、P3-2 §6 acceptance に「A-3 (compound boundary 完了 invariant)」行追加 (outer 完了済 + step 後続 case で `your_last_action = outer`)、P3-3 §9.1.1 merge order recommendation (A-1 → A-3 → A-2、`_envelope.ts` touch 領域 disjoint で rebase 簡単化)。Round 2 review pending。 |
| Drafted v0.3 | 2026-05-07 | Claude (Sonnet) | Round 2 Opus phase-boundary review (agentId ad36d5af75e178408、Conditionally Approved、Round 1 全 7 項目 resolved 確認 + 新規 P2 1 件 + P3 3 件) findings 反映: P2-A footer status drift 修正試行 (header `v0.1` → `v0.2` 同期、ただし v0.3 への flip 時に footer 同期忘却が Round 3 で再検出、最終的に v0.4 で footer literal 撤去で仕組み化解決)、P3-A `_envelope.ts` numeric drift 統一 (§1.3 表 A-2 行を `_envelope.ts:1380` commit-axis default + `_envelope.ts:1598` query-axis default の両 axis 表記に修正、`1570` 誤記訂正)、P3-B 改訂履歴 v0.2 entry に P3-1 / P3-2 言及追加で transparency 担保、P3-C §8 OQ #7 新設 (boundary 保護 entry の monotonic timeout 例外扱い 3 選択肢明記、CLAUDE.md §3.2 carry-over scope shrink 軸で Sonnet 実装時の既存挙動破壊リスク pin)。Status: Drafted v0.2 → v0.3。Round 3 review pending。 |
| Drafted v0.4 | 2026-05-07 | Claude (Sonnet) | Round 3 Opus phase-boundary review (agentId a21a558fa420bfb07、Conditionally Approved、Round 1 + Round 2 全 11 項目中 10 項目 Resolved + P2-A regression 検出) findings 反映: **P1-A (REGRESSION) footer drift 仕組み化解決** — footer から version literal 撤去 (`(see Status header for current version)` に置換、3 連続再発した同型盲点を CLAUDE.md 強制命令 7「仕組みで対応」で根絶)、P2-A §1.5 SSOT 参照節に `getSessionId` default `_envelope.ts:1380` (commit-axis) + `_envelope.ts:1598` (query-axis) 追加、P3-A §4.3.1 で test-only seam (`_seedHistoryForTest` line 983) と production path (`pushHistoryStarted` line 1045 周辺) の line range 区別注釈追加 + §10 Related artifacts に line range 精緻化 (`903-1100` → `920-1100`、test seam + eviction + FIFO production path 注釈)、P3-B Round 2 entry の自己矛盾記述 (「footer を v0.2 に修正」と書きながら v0.3 flip 時に footer 同期忘れ) を実態反映で修正。Status: Drafted v0.3 → v0.4。Round 4 review pending。 |
| Drafted v0.5 | 2026-05-07 | Claude (Sonnet) | Round 2 Opus phase-boundary review (agentId a446f69de34bd4e16) で指摘された **Round 2 残 findings (Round 3 では指摘されなかった分)** を完全反映: **P1 NEW-1 §4.3.5 新規** — `buildCausedBy` projection 改修節を独立 sub-section 化 (eviction skip だけでは acceptance 達成不可、boundary 優先 + 完了済 entry 探索 + 末尾 fallback ロジック明記、`buildBasedOn` 同型適用 + lastEvent 選択ヘルパ DRY 共有設計、§4.3.6 〜 §4.3.9 番号 bumping)、§4.3.7 PR scope に `buildCausedBy` (line 1087-1120) / `buildBasedOn` (line 1122-) lastEvent 選択拡張 bullet 追加、§9.1 表 A-3 行に同改修 column 追記、**P2 NEW-1 §3.3 line 189** macro.ts citation 統一 (`509-511` references を defining truth 区別、SSOT line `354 + 404-409` 明記、CLAUDE.md §3.1 同型再発抑制)、**P3 NEW-2 §1.2 line 34** 「9 query tool 中 8」記法明示化 (`= desktop_state 配線済 1 件を除く wire 対象 8 tool` 括弧書き)、**P3 NEW-3 §9.3** carry-over 解消 mark entry 順を §9.1.1 merge order (A-1 → A-3 → A-2 → A-4) に並び替え + 各 entry に「(merge 順 N 番目)」追記、**P3 NEW-1 v0.1 entry typo** 「9 PR breakdown」→「3 PR (A-1/A-2/A-3) + A-4 review-only breakdown」訂正。Status: Drafted v0.4 → v0.5。Round 4 review pending。 |
| Drafted v0.6 | 2026-05-07 | Claude (Sonnet) | Codex re-review (chatgpt-codex-connector、PR #155 comment 4392418727、最新 HEAD `63ed008` で再 review) findings 反映: **API contract / 構造 / scope shrink 軸で P1/P2 finding ゼロ**、技術 focus 4 点全 pass 確認 — (1) `ToolCallEvent` に `isCompoundBoundary` field 未存在 (A-3 が正しく planned work で land 済ではない、`_envelope.ts:920-943`)、(2) sessionId stub `getMcpTransportSessionId` returns `undefined` + `multi:disabled` sentinel branch + `_isSingleSessionPrototype` gating (A-2 finalize later framing 整合、`desktop-state.ts:751-793`)、(3) `run_macro` recursion 防止 + caveat text (A-3 motivation 整合、`macro.ts:354-355 + 404-409 + 500-505`)、(4) Query wrapper fast-path + default session `"default"` (A-1/A-2 baseline 整合、`_envelope.ts:1587-1599`)。**唯一の指摘 (P3 相当 process-state drift)**: Status header line 3 が「Round 4 review pending」となっていたが Round 4 Opus review は既に Approved 済 → Status line を「Round 1-4 Opus review + Codex re-review 全 findings apply 済、User reviewer 補正 window 待ち」に修正。Status: Drafted v0.5 → v0.6。User reviewer 補正 window (CLAUDE.md §3.3 Step 4) 待ち、その後 User judgment で merge (Step 5)。 |

---

END OF ADR-011 Phase A Plan (see Status header for current version).
