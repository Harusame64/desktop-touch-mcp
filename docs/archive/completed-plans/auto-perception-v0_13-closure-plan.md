# desktop-touch-mcp v0.13 — Final Closure of v3 Auto-Perception Plan

日付: 2026-04-17
対象: v0.12.0 → v0.13.0
前提ドキュメント: `docs/auto-perception-plan-v3.md`, v0.12 計画書 (`C:\Users\harus\.claude\plans\d-git-desktop-touch-mcp-docs-auto-perce-misty-summit.md`)

---

## 1. Context — なぜ v0.13 が v3 の最終クロージャなのか

v0.12 で v3 の Phase A + B + C を投入済み。残存するのは:

- 小さく scope が確定した backlog (Phase D Target-Identity Timeline; Phase E manual lens LRU)
- v3 §12 の未決事項（既に v0.12 コードで事実上決着しているが、正式な closure rationale が要る）
- GitHub Code Scanning の 7 件の open 指摘（全て v0.12 実装時に残った dead code / 未使用 var。セキュリティ問題なし）

v0.13 は**クロージャ・リリース**である。Phase D + E を実装し、§12 の全未決事項を retire し、CodeQL 指摘を全解消する。これにより `docs/auto-perception-plan-v3.md` と実コードが 100% 一致する。新方向・API 書き換え・新 required param は一切入れない。

v0.12 から継承する制約:

- 新しい `required` tool param を追加しない
- `lensId` workflow は byte-compatible
- `DESKTOP_TOUCH_AUTO_GUARD=0` は引き続き全 auto path を無効化
- Timeline 公開で `get_history` を bloat させない (v3 §10.6 警告)
- Manual lens API surface は byte-compatible（eviction policy のみ変更）

---

## 2. Scope 表 — v3 各節 × v0.13 の対応

| v3 § | トピック | v0.12 状態 | v0.13 対応 |
|---|---|---|---|
| §1 Core Product Rule | pass target hint | 実装済 | n/a |
| §2 Rationale | — | 記載済 | n/a |
| §3.1 Lens 管理からの解放 | 実装済 | n/a |
| §3.2 Implicit guarding | 実装済 (Phase A) | n/a |
| §3.3 Approve Model | 実装済 (Phase C, mouse_click) | **keyboard fixId は v0.14 へ正式 defer** |
| §3.4 Explicit escalation | 実装済 (`next` 文字列) | n/a |
| §4.1 Window target | 実装済 | n/a |
| §4.2 Browser target | readiness は一律 block | **`browser_click_element` のみ selector-in-viewport-warn を実装** |
| §4.3 Coordinate target | 実装済 (final tx,ty) | n/a |
| §5.1 Keyboard | 実装済 | n/a |
| §5.2 Mouse click | 実装済 | n/a |
| §5.2 Mouse drag endpoint | start のみ guard | **正式 defer（rationale 記載）** |
| §5.3 UIA | 実装済 | n/a |
| §5.4 Browser CDP click/nav | 実装済 | n/a |
| §5.4 Browser eval status line | guard-only | **v3 §5.4 optional として closure (実装なし)** |
| §6.1 HotTargetCache | 実装済; `attention` lifecycle 稼働 | **stale-identity LRU detail を確認・テスト追加して closure** |
| §6.2 Manual Lens LRU | MAX=16 FIFO | **Phase E — FIFO → LRU (touch-on-use)** |
| §6.3 Target-Identity Timeline | 未実装 | **Phase D — 完全実装** |
| §7 SuggestedFix (mouse) | 実装済 | n/a |
| §7 SuggestedFix (keyboard) | 未実装 | **v0.14 へ defer** |
| §8 Post response shape | 実装済 | n/a |
| §9 Phase D | — | **v0.13 で実装** |
| §9 Phase E | description は v0.12 で投入 | **v0.13 は LRU のみ** |
| §11 Unit tests | partial | **timeline + LRU + repeated-action-change テストを追加** |
| §11 E2E `perception_read` recall | D に blocked | **追加** |
| §12.1 Default-on | env flag shipped | **closure として明記** |
| §12.2 Ambiguous title | 実装済 | **closure として明記** |
| §12.3 Browser readiness | 一律 block | **選択的 warn を実装** |
| §12.4 Timeline resource surface | — | **D で決定: `get_history` + `perception_read` + `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` gated resource** |
| §12.5 Keyboard fix approval | — | **v0.14 defer** |
| §13 Final product rule | 実装済 | n/a |

---

## 3. 実装ルール（絶対条件、v0.12 から継承）

### ルール 1 — 2 回連続 trial&error → 即 Opus 委譲

同一ファイル / 同一テスト / 同一 guard 条件で 2 回連続して修正→失敗→修正→失敗が発生したら停止。Opus に「現状の失敗内容」「既試行」「仕様解釈の選択肢」を整理して相談する。Phase ごとに適用。

### ルール 2 — Phase 境界で Opus Spec-Alignment Review

Opus は以下 3 点の一致を確認する:

1. `docs/auto-perception-plan-v3.md`
2. 本 v0.13 計画
3. 各 Phase で投入された実コード

以下の checkpoint で発動。**指摘ゼロになるまで次 Phase へ進まない**。

- **Checkpoint D** — Phase D 完了直後
- **Checkpoint E** — Phase E 完了直後
- **Checkpoint F** — Phase F (open-decision closure + browser readiness) 完了直後
- **Checkpoint H** — Phase H (CodeQL 指摘クリーンアップ) 完了直後
- **Final** — v0.13 全体 + v3 closure map 確認

### ルール 3 — プラン本文書き換えは Opus のみ

Sonnet は `- [ ]` → `- [x]` の flip のみ可。それ以外の本文変更（仕様変更・scope 変更・削除）は Opus に相談して Opus が編集する。

### ルール 4 — Rel-5 以降の障害修正は Opus 専任

Release smoke で発見された障害は Sonnet の単独修正禁止。v0.12 方針を継承。

---

## 4. Progress Checklist

### Phase D — Target-Identity Timeline (v3 §6.3)

Core file:

- [ ] **D-1** `src/engine/perception/target-timeline.ts` 新規作成 (`TargetIdentityTimelineEvent` 型、13 種 semantic)
- [ ] **D-1** 保持定数: per-target ring `TARGET_RING_MAX = 32`、global cap `GLOBAL_EVENTS_MAX = 256`、session duration デフォルト
- [ ] **D-1** Public API: `appendEvent(partial)` / `listEventsForTarget(targetKey, n?)` / `listAllRecent(n)` / `listRecentTargetKeys(n)` / `compactOlderThan(ms)` / `_resetForTest()`
- [ ] **D-1** `eventId = "evt-" + randomUUID()`
- [ ] **D-1** `targetKey` 生成: `"window:{normalizedTitle}"` / `"browserTab:{tabId or urlIncludes}"`。`action-target.ts` に `deriveTargetKey(descriptor)` を export して `hot-target-cache.ts` の `descriptorKey` と共通化
- [ ] **D-1** unit test 14 件通過 (append / ring evict / global cap / order / compaction summary / reset / eventId uniqueness)

Integration — action-guard emission:

- [ ] **D-2** `src/tools/_action-guard.ts::runActionGuard` で `resolveActionTarget` 成功直後に `target_bound` を emit（`HotTargetSlot.useCount === 0` で dedupe）
- [ ] **D-2** `evaluateGuards` 前に `action_attempted` を emit（`tool`, `descriptor` 付き）
- [ ] **D-2** `mapGuardResult` 後に `block === true` なら `action_blocked`（`failedGuard.kind` を summary に含む）
- [ ] **D-2** `resolved.changed` が entries を持つ場合、該当する `rect_changed` / `title_changed` / `identity_changed` / `navigation` を emit
- [ ] **D-2** `candidates === 0` かつ前 slot が cache 上に存在していた場合 `target_closed` を emit
- [ ] **D-2** unit test: 全 guard path が 1 action あたり最低 1 event emit

Integration — manual lens emission:

- [ ] **D-3** `src/engine/perception/registry.ts::_registerWindowLens` / `_registerBrowserTabLens` で `target_bound` を emit（`source: "manual_lens"`）
- [ ] **D-3** `removeLensInternal` で `target_closed`（`result: reason === "evict" ? "failed" : "ok"`）
- [ ] **D-3** lens lifecycle listener の identity 変化を `identity_changed` に変換
- [ ] **D-3** `flushDirty → executeRefreshPlan` 内の `_recentChanges` 差分を `emitFluentChangeEvents(lensId, changedKeys)` helper 経由で以下に変換:
  - `target.title` → `title_changed`
  - `target.rect` → `rect_changed`
  - `target.foreground` → `foreground_changed`
  - `target.identity` → `identity_changed`
  - `browser.url` → `navigation`
  - `modal.above` → `modal_appeared` / `modal_dismissed`（before/after 値で判定）
  Burst 抑制のため helper 内で同 key × 同 semantic を 200ms debounce

Integration — post-action check:

- [ ] **D-4** `src/tools/_post.ts::withPostState` 成功 path で `windowChanged && before.hwnd !== after.hwnd` 時に `foreground_changed` を emit（`source: "post_check"`）
- [ ] **D-4** `ok: true` かつ `_perceptionForPost` が拾われた時に `action_succeeded` を emit（`source: "post_check"`, `targetKey` は `summary.target` から生成）
- [ ] **D-4** modal transition 検知は v0.13 では gate 下で未実装とし将来対応 (§6.3 の `modal_appeared`/`dismissed` は manual lens 経由のみ emit)
- [ ] **D-4** unit test: 成功 action は `action_attempted` + `action_succeeded` を emit、blocked action は `action_attempted` + `action_blocked` を emit

Exposure:

- [ ] **D-5** `src/tools/context.ts::getHistoryHandler`: response に `recentTargetKeys: listRecentTargetKeys(3)` を追加。個別 event は含めない（history bloat 回避）
- [ ] **D-5** `src/tools/perception.ts::perceptionReadHandler`: `readLens` 後に `recentEvents: Array<{ tsMs, semantic, summary, tool?, result? }>`（最大 10 件）を envelope に追加
- [ ] **D-5** MCP resource 決定: `perception://target/{targetKey}/timeline` を既存 `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` flag 配下で公開。`src/tools/perception-resources.ts` の既存 `perception://lens/...` テンプレートの横に並べる
- [ ] **D-5** `perception-resources.ts` ヘッダコメントに timeline resource の仕様を記載
- [ ] **D-5** unit test: `perception_read(lensId)` が recentEvents を返す。MCP resource (flag ON) が `{ targetKey, events: [...] }` を返す

Checkpoint:

- [ ] **🔍 Checkpoint D — Opus Spec-Alignment Review**: 指摘ゼロで次 Phase へ

### Phase E — Manual Lens LRU + Prompt Surface (v3 §6.2, §9 Phase E, §10.7)

- [ ] **E-1** `src/engine/perception/registry.ts` に `touchLens(lensId)` 追加（`lensOrder` 内で対象を末尾へ splice）
- [ ] **E-2** `evictOldestIfNeeded()` は本体変更なし。`lensOrder[0]` は touch 後常に LRU を指すことになる。コメントで「lensOrder is maintained in LRU order」と明示
- [ ] **E-3** touch 呼出し追加:
  - `evaluatePreToolGuards(lensId, ...)` 入口
  - `buildEnvelopeFor(lensId, ...)` 入口
  - `readLens(lensId, ...)` 入口
- [ ] **E-3** `listLenses()` では touch しない（listing は LRU 順を変えない）
- [ ] **E-3** sensor loop からは touch しない（background refresh は生死判定を変えない）
- [ ] **E-4** unit test: 16 lens 登録 → lens 0 を repeated touch → 17 lens目登録 → lens 1 が evict される
- [ ] **E-5** `onForgotten(lensId, "evict")` が新しい LRU evict 対象に正しく発火するか確認
- [ ] **E-6** Prompt-surface 差分確認（v0.12 で大半投入済、v0.13 は仕上げ）:
  - 既完了: `perception_register`, `browser_navigate`, `browser_click_element`, `set_element_value`, `perception_read`
  - [ ] **E-6a** `src/tools/mouse.ts` `mouse_click`/`mouse_drag`, `src/tools/keyboard.ts` `keyboard_type`/`keyboard_press`, `src/tools/ui-elements.ts` `click_element` の description を audit。「windowTitle を渡せばサーバが自動 guard する」という一貫した wording に統一。Glama 総文字数制約に注意
- [ ] **E-7** Phase F の browser readiness closure が入る場合、`browser_click_element` description に warn 挙動を 1 行追記

Checkpoint:

- [ ] **🔍 Checkpoint E — Opus Spec-Alignment Review**: 指摘ゼロで次 Phase へ

### Phase F — Open-decision closure (v3 §12) + 小クロージャ

- [ ] **F-1** §12.1 Default-on: v0.12 で default-on + `DESKTOP_TOUCH_AUTO_GUARD=0` rollback として closure 済。CHANGELOG / v3 map に明記。コード変更なし
- [ ] **F-2** §12.2 Ambiguous title: v0.12 で keyboard/UIA は fail-closed、mouse は coord rescue として closure 済。`_action-guard.ts::runActionGuard` の `candidates > 1` 分岐の上に v3 §4.1 step 4 への参照コメントを追加
- [ ] **F-3** §12.3 Browser readiness — `browser_click_element` のみ選択的 warn を実装:
  - `src/engine/perception/guards.ts::evalBrowserReady` に `ctx.browserSelectorInViewport === true` 時の警告分岐を追加。その場合 `readyState !== "complete"` でも `ok: true, note: "warn: readyState=... but selector in viewport"` で通す
  - `src/engine/perception/guards.ts::GuardContext` に `browserSelectorInViewport?: boolean` を追加
  - `src/tools/_action-guard.ts::runActionGuard` の params に `browserSelectorInViewport?: boolean` を追加し `ctx` に forward
  - `src/tools/browser.ts::browserClickElementHandler` で `getElementScreenCoords` の `inViewport` を取得し `runActionGuard` に渡す
  - `browser_navigate` / `browser_eval` は strict block を維持
- [ ] **F-3** unit test: in-viewport selector + `readyState: "loading"` → pass with note。`inViewport: false` → block。navigate/eval は strict block を維持
- [ ] **F-4** §12.4 Timeline resource surface: Phase D-5 で実装済（flag gate）。CHANGELOG に明記
- [ ] **F-5** §12.5 Keyboard fixId approval — **v0.14 へ正式 defer**。理由をプラン内と CHANGELOG に記載（mouse_click fixId は 1 リリース分の本番 signal があるが、keyboard fix は `focusWindowForKeyboard` との相互作用で新しい fingerprint surface を持ち込むため、実障害事例を待ってから実装する）。`SuggestedFix.tool` 型は `"mouse_click"` の単一リテラルのまま（consumer narrowing を壊さない）
- [ ] **F-6** `mouse_drag` endpoint guard — **正式 defer（恒久）**。`mouseDragHandler` の guard ブロック上に v3 §5.2 への参照コメントを追加（「start point is safety-critical; cross-window drag 互換のため endpoint は guard しない」）
- [ ] **F-7** `browser_eval` compact status line — **v3 §5.4 optional として closure**。`browserEvalHandler` に v3 §5.4 参照コメント、コード変更なし
- [ ] **F-8** HotTargetCache stale-identity LRU detail — 現実装を検査:
  - (a) LRU tiebreak が `lastUsedAtMs` 使用
  - (b) bad-TTL 済 slot を `clearExpired` が回収
  - (c) `getOrCreateSlot` が read-only 呼出しで TTL 延長しない
  実装が §6.1 に準拠しているか確認し、assertion 用 unit test を 1 件追加して closure
- [ ] **F-9** Glama listing v0.12 description update — release ops タスクとして user action 欄に残す（コード変更なし）

Checkpoint:

- [ ] **🔍 Checkpoint F — Opus Spec-Alignment Review**: 指摘ゼロで次 Phase へ

### Phase H — GitHub Code Scanning 指摘クリーンアップ

対象: repo `Harusame64/desktop-touch-mcp` の open code-scanning alerts 全 7 件。v0.12 実装の残渣で、全てローカル cleanup。セキュリティ影響なし。

warning (1 件):

- [ ] **H-1** Alert #66 `js/trivial-conditional` `src/tools/_action-guard.ts:344` — `descriptor` が常に truthy で評価される dead conditional。`resolveActionTarget` の return 型を見直し、`descriptor` null チェックを削除するか、上流の contract を明示化して適切に narrow する

note (6 件):

- [ ] **H-2** Alert #65 `tests/unit/resolve-action-target.test.ts:13` — `mockResetLensCounter` 未使用 → 削除
- [ ] **H-3** Alert #64 `tests/unit/post-failure-perception.test.ts:10` — `mockSnapshotFocusedElement` 未使用 → 削除
- [ ] **H-4** Alert #63 `tests/unit/post-failure-perception.test.ts:10` — `mockSnapshotFocus` 未使用 → 削除
- [ ] **H-5** Alert #62 `tests/unit/post-failure-perception.test.ts:7` — `beforeEach` import 未使用 → 削除
- [ ] **H-6** Alert #61 `src/tools/_action-guard.ts:227` — `guardPolicy` 未使用 variable → 削除もしくは実際に使用するように配線
- [ ] **H-7** Alert #60 `src/engine/perception/action-target.ts:27` — `getCachedWindowByTitle` import 未使用 → 削除

- [ ] **H-8** 各修正後 `gh api repos/Harusame64/desktop-touch-mcp/code-scanning/alerts/<num> -X PATCH -f state=dismissed -f dismissed_reason=fixed` は**しない**。alert は push 後の CodeQL 再 scan で自動 close されるのを待つ（人為 dismiss は履歴を汚す）
- [ ] **H-9** `npm run test` + `npm run build` を通す。既存動作に影響が出ていないこと確認

Checkpoint:

- [ ] **🔍 Checkpoint H — Opus Spec-Alignment Review**: `js/trivial-conditional` の修正が仕様変更を含んでいないか Opus が確認。指摘ゼロで次へ

### Test additions

- [ ] **T-1** `tests/unit/target-timeline.test.ts` — ring / global cap / compaction / reset
- [ ] **T-2** `tests/unit/target-timeline.integration.test.ts` — emit-from-action-guard / emit-from-manual-lens / emit-from-post-check
- [ ] **T-3** `tests/unit/registry-lru.test.ts` — touch-then-evict / 16-slot saturation / listLenses は touch しない / evict listener 発火
- [ ] **T-4** `tests/unit/browser-ready-selective-warn.test.ts` — `evalBrowserReady` with/without `browserSelectorInViewport`
- [ ] **T-5** `tests/unit/hot-target-cache.test.ts` 拡張 — F-8 の stale-identity assertion
- [ ] **T-6** `tests/e2e/perception-recall.e2e.test.ts` — `perception_read(lensId)` が repeated click 後に recentEvents を返す
- [ ] **T-7** `tests/e2e/repeated-action-changes.e2e.test.ts` — 2 連続 `mouse_click` の間に window 移動 → 2 回目が `changed: ["rect"]` を返す
- [ ] **T-8** Contract snapshot audit: `post.perception` の新規 optional field (`recentEvents`, `recentTargetKeys`) が additive であること確認
- [ ] **T-9** keyboard `fixId` の E2E は v0.14 へ defer（追加しない）

### リリース準備

- [ ] **Rel-1** `package.json` / `package-lock.json` / `src/version.ts` → `0.13.0`
- [ ] **Rel-2** `CHANGELOG.md` に v0.13.0 セクション追加
- [ ] **Rel-3** `npm run build` OK、`dist/` 生成確認
- [ ] **Rel-4** `npm run test` 全件 green（既存 968 + 新規約 40）
- [ ] **Rel-5** 手動 smoke 8 シナリオ通過（§11 参照）
- [ ] **Rel-6** `npm publish`（2FA ブラウザ認証、ユーザー担当）
- [ ] **Rel-7** `scripts/check-downloads.sh` で npx DL smoke（別 PowerShell）
- [ ] **Rel-8** Glama 同期（Build → Make Release、user action）
- [ ] **Rel-9** README に `perception://target/{targetKey}/timeline` + `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` flag 追記
- [ ] **Rel-10** push 後 `gh api repos/Harusame64/desktop-touch-mcp/code-scanning/alerts?state=open` で open alert 0 件を確認

- [ ] **🔍 Final Checkpoint — Opus 全体再レビュー**: v3 closure map + CodeQL 指摘 0 + 全テスト green を確認

### 🔒 Rel-5 以降の障害修正ルール（v0.12 から継承）

Rel-5 以降で発見されたバグは Opus 専任で調査・修正する。Sonnet は症状・ログ・コードの読み取り補助のみ。

---

## 5. Per-phase 実装ステップ

### 5.1 Phase D — Target-Identity Timeline

#### 新規ファイル `src/engine/perception/target-timeline.ts`

```ts
import { randomUUID } from "node:crypto";
import type { WindowIdentity, BrowserTabIdentity } from "./types.js";
import type { ActionTargetDescriptor } from "./action-target.js";

export type TimelineSemantic =
  | "target_bound"
  | "action_attempted" | "action_succeeded" | "action_blocked"
  | "title_changed" | "rect_changed" | "foreground_changed"
  | "navigation" | "modal_appeared" | "modal_dismissed"
  | "identity_changed" | "target_closed";

export interface TargetIdentityTimelineEvent {
  eventId: string;
  tsMs: number;
  targetKey: string;
  identity: WindowIdentity | BrowserTabIdentity | null;
  descriptor?: ActionTargetDescriptor;
  source: "action_guard" | "manual_lens" | "post_check" | "sensor";
  semantic: TimelineSemantic;
  summary: string;
  tool?: string;
  result?: "ok" | "blocked" | "failed";
}

export const TARGET_RING_MAX = 32;
export const GLOBAL_EVENTS_MAX = 256;

const _byKey = new Map<string, TargetIdentityTimelineEvent[]>();
const _globalOrder: Array<{ key: string; eventId: string }> = [];

export function appendEvent(
  partial: Omit<TargetIdentityTimelineEvent, "eventId" | "tsMs"> & { tsMs?: number }
): TargetIdentityTimelineEvent { /* ring + global cap + summary compaction */ }

export function listEventsForTarget(key: string, n = 10): TargetIdentityTimelineEvent[];
export function listRecentTargetKeys(n = 5): string[];
export function listAllRecent(n: number): TargetIdentityTimelineEvent[];
export function compactOlderThan(ms: number): void;
export function _resetForTest(): void;
```

#### 統合 — `_action-guard.ts::runActionGuard`

1. `resolveActionTarget` 後に `deriveTargetKey(descriptor)` で key を生成（`action-target.ts` から export）
2. 新 slot 時に `target_bound` emit
3. `evaluateGuards` 前に `action_attempted` emit
4. `mapGuardResult` 後、`block` なら `action_blocked` emit。成功時は `_post.ts` 側で `action_succeeded` emit（二重 emit 回避）
5. `resolved.changed` の各 kind を対応 semantic に変換して emit
6. `candidates === 0` かつ前 slot あり → `target_closed` emit

#### 統合 — `registry.ts`

- `_registerWindowLens` / `_registerBrowserTabLens` 後に `target_bound` (source: manual_lens)
- `removeLensInternal` で `target_closed`
- `executeRefreshPlan` 内の `_recentChanges` → `emitFluentChangeEvents(lensId, changedKeys)` helper
- Burst 抑制: 同 target × 同 semantic を 200ms debounce

#### 統合 — `_post.ts::withPostState`

- 成功 path で `_perceptionForPost` 拾った後に `action_succeeded` emit
- `windowChanged && before.hwnd !== after.hwnd` で `foreground_changed` emit

#### 公開 — `context.ts::getHistoryHandler`

```ts
const items = getHistorySnapshot(n);
const recentTargetKeys = listRecentTargetKeys(3);
return ok({ count: items.length, actions: items, recentTargetKeys });
```

個別 item に event を埋めない（bloat 回避）。

#### 公開 — `perception.ts::perceptionReadHandler`

```ts
const envelope = await readLens(params.lensId, { maxTokens: params.maxTokens });
const lens = getLens(params.lensId);
const targetKey = lens ? deriveLensTargetKey(lens) : null;
const recentEvents = targetKey
  ? listEventsForTarget(targetKey, 10).map(compactEvent)
  : [];
return ok({ ok: true, ...envelope, ...(recentEvents.length && { recentEvents }) });
```

`compactEvent` は `{ tsMs, semantic, summary, tool?, result? }` のみ（identity/descriptor を落とす）。

#### 公開 — MCP resource (flag-gated)

`src/tools/perception-resources.ts` の既存 `perception://lens/...` 登録の隣に:

```ts
if (process.env.DESKTOP_TOUCH_PERCEPTION_RESOURCES === "1") {
  const timelineTemplate = new ResourceTemplate(
    "perception://target/{targetKey}/timeline",
    {
      list: async () => ({
        resources: listRecentTargetKeys(20).map(k => ({
          uri: `perception://target/${encodeURIComponent(k)}/timeline`,
          name: `timeline:${k}`,
          mimeType: "application/json",
        })),
      }),
      complete: { targetKey: async () => listRecentTargetKeys(20) },
    }
  );
  server.registerResource(
    "perception-target-timeline",
    timelineTemplate,
    {
      title: "Target-Identity Timeline",
      description: "Recent semantic events for a target (v3 §6.3).",
      mimeType: "application/json",
    },
    async (uri, { targetKey }) => {
      const key = Array.isArray(targetKey) ? targetKey[0] : targetKey;
      const events = listEventsForTarget(decodeURIComponent(key), 50);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ targetKey: key, events }),
        }],
      };
    }
  );
}
```

### 5.2 Phase E — Manual Lens LRU

`src/engine/perception/registry.ts` 改修:

```ts
function touchLens(lensId: string): void {
  const idx = lensOrder.indexOf(lensId);
  if (idx >= 0 && idx !== lensOrder.length - 1) {
    lensOrder.splice(idx, 1);
    lensOrder.push(lensId);
  }
}
```

touch 呼出し追加位置:

- `evaluatePreToolGuards`: `const lens = lenses.get(lensId); if (!lens) throw ...` 直後
- `buildEnvelopeFor`: 同上
- `readLens`: 同上

`evictOldestIfNeeded()` 本体は変更不要。`lensOrder[0]` が常に LRU を指すコメントを追加。

### 5.3 Phase F — Browser readiness 差分化

1. `src/engine/perception/guards.ts::evalBrowserReady`:
   ```ts
   if (readyState.value !== "complete") {
     if (ctx?.browserSelectorInViewport === true) {
       return {
         kind, ok: true, confidence: readyState.confidence,
         note: `warn: readyState="${readyState.value}" but selector in viewport`,
       };
     }
     return { kind, ok: false, ... };
   }
   ```
2. `GuardContext` に `browserSelectorInViewport?: boolean` 追加
3. `_action-guard.ts::RunActionGuardParams` に同フィールド追加、`ctx` に forward
4. `browser.ts::browserClickElementHandler`: `getElementScreenCoords.inViewport` を `runActionGuard` に渡す

### 5.4 Phase F — 小クロージャ

- **F-2**: `_action-guard.ts` の ambiguous 分岐上に v3 §4.1 step 4 参照コメント
- **F-5**: `SuggestedFix.tool` は `"mouse_click"` リテラルのまま（consumer narrowing 維持）。v0.14 で union 化予定のコメント
- **F-6**: `mouseDragHandler` の guard ブロックに v3 §5.2 参照コメント
- **F-7**: `browserEvalHandler` に v3 §5.4 参照コメント
- **F-8**: `hot-target-cache.test.ts` に assertion 1 件追加

### 5.5 Phase H — CodeQL 指摘クリーンアップ

| Alert | File | 修正方針 |
|---|---|---|
| #66 warning | `src/tools/_action-guard.ts:344` | `descriptor` 常 truthy の trivial-conditional を削除。null チェックの上流 contract を明確化 |
| #65 | `tests/unit/resolve-action-target.test.ts:13` | `mockResetLensCounter` 削除 |
| #64 | `tests/unit/post-failure-perception.test.ts:10` | `mockSnapshotFocusedElement` 削除 |
| #63 | `tests/unit/post-failure-perception.test.ts:10` | `mockSnapshotFocus` 削除 |
| #62 | `tests/unit/post-failure-perception.test.ts:7` | `beforeEach` import 削除 |
| #61 | `src/tools/_action-guard.ts:227` | `guardPolicy` 未使用 var → 削除もしくは forward 配線 |
| #60 | `src/engine/perception/action-target.ts:27` | `getCachedWindowByTitle` import 削除 |

いずれも動作影響なし（全テスト通過要件）。push 後 CodeQL が自動的に alert を close。

---

## 6. Critical Files (open する順)

1. `D:\git\desktop-touch-mcp\src\engine\perception\target-timeline.ts` — 新規
2. `D:\git\desktop-touch-mcp\src\engine\perception\action-target.ts` — `deriveTargetKey` export、H-7 cleanup
3. `D:\git\desktop-touch-mcp\src\tools\_action-guard.ts` — emit 配線、`browserSelectorInViewport` 通し、H-1/H-6 cleanup
4. `D:\git\desktop-touch-mcp\src\engine\perception\registry.ts` — `touchLens`、manual lens emit
5. `D:\git\desktop-touch-mcp\src\tools\_post.ts` — action_succeeded emit
6. `D:\git\desktop-touch-mcp\src\tools\perception.ts` — recentEvents
7. `D:\git\desktop-touch-mcp\src\tools\context.ts` — recentTargetKeys
8. `D:\git\desktop-touch-mcp\src\tools\perception-resources.ts` — timeline resource
9. `D:\git\desktop-touch-mcp\src\engine\perception\guards.ts` — `evalBrowserReady` selective-warn
10. `D:\git\desktop-touch-mcp\src\tools\browser.ts` — in-viewport flag forward、F-7 コメント
11. `D:\git\desktop-touch-mcp\src\tools\mouse.ts` — F-6 コメント
12. `D:\git\desktop-touch-mcp\tests/unit/post-failure-perception.test.ts` — H-2/H-3/H-4/H-5 cleanup
13. `D:\git\desktop-touch-mcp\tests/unit/resolve-action-target.test.ts` — H-2 cleanup
14. `D:\git\desktop-touch-mcp\package.json` + `src\version.ts` — v0.13.0
15. `D:\git\desktop-touch-mcp\CHANGELOG.md` — v0.13 section

---

## 7. 再利用する既存 helper (新規実装しない)

- `normalizeTitle` — `src/engine/perception/action-target.ts`
- `resolveActionTarget` — `src/engine/perception/action-target.ts`
- `getOrCreateSlot` / `updateSlot` / `markBad` — `src/engine/perception/hot-target-cache.ts`
- `compileLens` / `resolveBindingFromSnapshot` — `src/engine/perception/lens.ts`
- `buildWindowIdentity` / `refreshWin32Fluents` — `src/engine/perception/sensors-win32.ts`
- `evaluateGuards` / `evalBrowserReady` — `src/engine/perception/guards.ts`
- `listTabsLight` / `refreshCdpFluents` — cdp-bridge / sensors-cdp
- `storeFix` / `resolveFix` / `consumeFix` — `src/engine/perception/suggested-fix-store.ts`
- `randomUUID` — `node:crypto`
- `ResourceTemplate` / `server.registerResource` — MCP SDK via `src/tools/perception-resources.ts`
- `addLensLifecycleListener` / `addPerceptionChangeListener` — `src/engine/perception/registry.ts`

---

## 8. テスト戦略

### Unit (+約 40)

| 対象 | 件数 | 内容 |
|---|---|---|
| target-timeline ring/cap/compact | 14 | ring per-key、global cap、compactOlderThan、reset、eventId uniqueness |
| target-timeline integration (action-guard) | 8 | target_bound / action_attempted / action_blocked / rect/title/identity/navigation / target_closed |
| target-timeline integration (manual lens) | 4 | register → forget、evict、identity change、modal |
| target-timeline integration (post_check) | 4 | ok:true で action_succeeded、hwnd flip で foreground_changed |
| registry LRU | 4 | touch 末尾移動、17 lens 登録で正 slot evict、listLenses が touch しない、evict listener 発火 |
| evalBrowserReady selective warn | 3 | inViewport: false で block、inViewport: true + loading で pass-with-note、navigate/eval は strict |
| hot-target-cache stale identity | 1 | F-8 assertion |
| CodeQL cleanup regression | 0 | 既存テストが全 green なら OK（新規テスト不要） |

### E2E (+4)

- `perception_read(lensId)` が 3 連続 `keyboard_type` 後に recentEvents 返却
- `get_history` response が `recentTargetKeys` 含む
- MCP resource `perception://target/window:notepad/timeline` が flag ON で events 返却、flag OFF で invisible
- 2 連続 `mouse_click` の間に window 移動 → 2 回目が `changed: ["rect"]`

### Contract

- `post.perception` shape 不変
- 新規 optional field `recentEvents`, `recentTargetKeys` は additive
- snapshot 更新は `tests/contract/perception-read.contract.test.ts`（存在すれば）、`get_history` 系のみ

---

## 9. CHANGELOG テンプレート (v0.13.0)

```
## [0.13.0] - 2026-04-xx — v3 Closure

### Added (Phase D — Target-Identity Timeline)
- Semantic target-scoped event timeline (`target_bound`, `action_attempted`,
  `action_succeeded`, `action_blocked`, `title_changed`, `rect_changed`,
  `foreground_changed`, `navigation`, `modal_appeared`, `modal_dismissed`,
  `identity_changed`, `target_closed`). Retention: per-target ring (32),
  global cap (256), session-scoped.
- `get_history` now returns a compact `recentTargetKeys` array.
- `perception_read(lensId)` now returns `recentEvents` (up to 10) for the
  lens's target.
- MCP resource `perception://target/{targetKey}/timeline` behind the existing
  `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` flag.

### Changed (Phase E — Manual Lens LRU)
- Manual lens eviction is now LRU (touch-on-use) instead of FIFO. Registering
  a new lens when 16 are active evicts the least-recently-used lens. MAX=16.

### Changed (Browser readiness — v3 §12.3 closure)
- `browser_click_element` no longer blocks on `readyState !== "complete"` when
  the target selector is already in viewport. It passes with a warn note.
  `browser_navigate` and `browser_eval` retain strict block behavior.

### Chore (Code Scanning cleanup)
- Removed 1 trivial conditional and 6 unused local variables/imports flagged
  by GitHub Code Scanning (CodeQL). No behavior change.

### Deferred
- Keyboard `fixId` approval deferred to v0.14 (v3 §7 staged rollout).
- `mouse_drag` endpoint guard intentionally not added (v3 §5.2).
- `browser_eval` compact status line left optional (v3 §5.4).

### Compatibility
- Existing `lensId` workflows unchanged.
- `post.perception` shape unchanged.
- New fields `recentEvents` / `recentTargetKeys` are additive.
- `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` is opt-in for the timeline resource.
```

---

## 10. Known Risks / Caveat

- **R1 — history bloat (v3 §10.6)**: `get_history` は event を埋めない。`recentTargetKeys` 3 件のみ。Event は別 store。
- **R2 — LRU で既存 workflow 影響**: MAX=16 に達して evict する user は v0.13 で evict 対象が変わる。CHANGELOG で明示。
- **R3 — MCP resource flag semantics**: `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` は既存 `perception://lens/...` ゲートを流用。timeline resource も同 flag 配下。
- **R4 — Timeline emit burst**: sensor loop が rect 変化を 20Hz で打つ可能性。`emitFluentChangeEvents` で per-key-per-semantic 200ms debounce。T-2 で assert。
- **R5 — `touchLens` race vs forget**: `lenses.get` と `lensOrder.splice` の間に forget が走ると `indexOf` が -1 で no-op。安全。
- **R6 — Browser readiness warn の意味**: `evalBrowserReady` の pass-with-note は `AutoGuardEnvelope.status = "ok"` を返すが、`summary.next` に note を通して LLM に可視化する。
- **R7 — Timeline store の test reset**: `_resetForTest()` を export し、既存 `registry.ts::__resetForTests` harness に配線。
- **R8 — Keyboard fixId 将来拡張**: v0.13 は `SuggestedFix.tool` を `"mouse_click"` リテラルのまま維持。v0.14 で union 化と emit path を同時に投入。
- **R9 — CodeQL 再 scan のタイミング**: Phase H 修正を push 後、CodeQL が再走して alert が自動 close されるまで数分。Rel-10 で open=0 を確認する。

---

## 11. 検証手順

### Automated

1. `npm run build` — 型エラーなし
2. `npm run test` — 既存 968 + 新規約 40 件が green
3. `npm run test:e2e:win` — 新規 E2E 4 件 + 既存全件 green
4. `scripts/check-downloads.sh` npx DL smoke（`npm publish` 後）
5. `gh api repos/Harusame64/desktop-touch-mcp/code-scanning/alerts?state=open` → 0 件

### Manual smoke (`docs/release-process.md` 参照)

1. `DESKTOP_TOUCH_AUTO_GUARD=1` + `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` で起動
2. Notepad 起動 → `keyboard_type({windowTitle:"Notepad", text:"hi"})` ×3 → 全て `post.perception.status="ok"`
3. `perception_register({name:"n", target:{kind:"window", match:{titleIncludes:"Notepad"}}})` → `perception_read({lensId})` → `recentEvents` 配列に ≥3 `action_succeeded` 含む
4. Notepad 窓を移動 → 元座標で `mouse_click` → `post.perception.changed: ["rect"]` もしくは `identity_changed` + fix 復旧
5. 17 lens 登録ループ → lens #0 を touch → lens #1 が evict され lens #0 が生存（LRU）
6. Chrome tab が `readyState="loading"` 中に `browser_click_element({selector:"#btn"})` で selector が viewport 内 → warn note 付きで click 実行
7. MCP inspector で `perception://target/window:notepad/timeline` → events JSON body 取得
8. `DESKTOP_TOUCH_AUTO_GUARD=0` で起動し直し → Step 2 が v0.11.12 相当挙動

---

## 12. v3 doc 完全クロージャ map

| v3 § | v0.13 後の状態 | 根拠 |
|---|---|---|
| §1 Core Product Rule | Implemented | v0.12 Phase A |
| §2 Rationale | N/A | Design prose |
| §3.1 Lens 管理からの解放 | Implemented | v0.12 |
| §3.2 Implicit guarding | Implemented | v0.12 Phase A |
| §3.3 Approve Model (mouse) | Implemented | v0.12 Phase C |
| §3.4 Explicit escalation | Implemented | v0.12 |
| §4.1 Window target | Implemented | v0.12 |
| §4.2 Browser target — selector-in-viewport warn | Implemented | **v0.13 F-3** |
| §4.3 Coordinate target | Implemented | v0.12 |
| §5.1 Keyboard | Implemented | v0.12 |
| §5.2 Mouse click | Implemented | v0.12 |
| §5.2 Mouse drag endpoint | **Intentionally deferred** | v3 §5.2 rationale; v0.13 F-6 |
| §5.3 UIA | Implemented | v0.12 |
| §5.4 Browser CDP click/nav | Implemented | v0.12 |
| §5.4 Browser eval status line | **Intentionally deferred (optional)** | v3 §5.4; v0.13 F-7 |
| §6.1 HotTargetCache | Implemented + verified | v0.12 + v0.13 F-8 |
| §6.2 Manual Lens LRU | Implemented | **v0.13 Phase E** |
| §6.3 Target-Identity Timeline | Implemented | **v0.13 Phase D** |
| §7 SuggestedFix (mouse_click) | Implemented | v0.12 Phase C |
| §7 SuggestedFix (keyboard) | **Deferred to v0.14** | v3 §7 staged rollout; v0.13 F-5 |
| §8 Post response shape | Implemented | v0.12 |
| §9 Phase A/B/C | Implemented | v0.12 |
| §9 Phase D | Implemented | v0.13 |
| §9 Phase E | Implemented | v0.13 |
| §10 Source map | Superseded | v0.13 計画で最新行番号 |
| §11 Unit tests | Covered | v0.12 + v0.13 T-1..T-5 |
| §11 E2E recall | Covered | v0.13 T-6 |
| §11 E2E fixId (mouse) | Covered | v0.12 |
| §11 E2E fixId (keyboard) | Deferred to v0.14 | v0.13 F-5 |
| §12.1 Default-on | Closed: default-on + env rollback | v0.12 |
| §12.2 Ambiguous title | Closed | v0.12 |
| §12.3 Browser readiness | Closed: selective warn for click | v0.13 F-3 |
| §12.4 Timeline resource surface | Closed: history + perception_read + flag-gated resource | v0.13 D-5 |
| §12.5 Keyboard fix approval | Closed: v0.14 defer | v0.13 F-5 |
| §13 Final product rule | Implemented | v0.12/v0.13 descriptions |

v0.13 リリース後、全 §N が「Implemented」または「Intentionally deferred with rationale」のいずれかになり、v3 は closed。

---

## 13. v0.14 mini-checklist（本計画の対象外、参考）

本番で keyboard fix approval が必要な実障害が出たら:

- [ ] `SuggestedFix.tool` を `"mouse_click" | "keyboard_type"` に widening
- [ ] `runActionGuard` で keyboard identity/foreground drift 時に SuggestedFix を emit
- [ ] `keyboard_type` schema に optional `fixId?` を追加
- [ ] E2E `keyboard_type({fixId})` テスト追加
- [ ] narrow CHANGELOG で v0.14.0 としてリリース

---

## 日本語サマリ (1 段落)

v0.13 は v3 設計書の完全クロージャ。Phase D (Target-Identity Timeline、`target-timeline.ts`、13 種 semantic、ring+global cap、history/perception_read/resource exposure) と Phase E (Manual Lens LRU、`evaluatePreToolGuards`/`buildEnvelopeFor`/`readLens` 入口で `touchLens`) を投入。§12 の 5 未決事項を全 closure — Default-on は v0.12 で決着済として明記、Ambiguous title は既存実装で明記、Browser readiness は `browser_click_element` のみ selector-in-viewport-warn、Timeline resource は `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` flag 配下、Keyboard fixId は v0.14 に正式 defer。さらに GitHub Code Scanning の open 7 件 (1 warning + 6 notes、全て v0.12 残渣の unused/dead) を Phase H で一括解消。新しい required param なし、`lensId` workflow は byte-compatible。v0.13 リリース後、v3 各 § は「Implemented」もしくは「Intentionally deferred with rationale」のどちらかになり、設計書と実装が 100% 一致する。
