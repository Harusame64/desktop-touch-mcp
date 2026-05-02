# Walking skeleton expansion plan (post-trunk worktree 並走戦略)

- Status: **Drafted (2026-05-01)**
- Trigger: walking-skeleton trunk completion (S6 G6 通過、PR #?)
- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §6 Expansion 並列化計画 (line 354-390) + CLAUDE.md §3.4 (Max 20x 並走戦略)
- 親 base: trunk 5 構造的 contract (CausedByShape 4 field + envelope top-level BasedOnShape + sentinel runtime closed loop + monotonic timeout + desktop-state.ts wiring) を mechanical コピーで全 expansion tool に波及

---

## 1. Expansion phase 構造

trunk で確立した **5 構造的 contract** を mechanical コピーで全 expansion tool に波及させる:

| # | trunk contract | expansion 適用方針 |
|---|---|---|
| 1 | CausedByShape 4 field + envelope top-level BasedOnShape | makeQueryWrapper / makeCommitWrapper を呼ぶだけで自動波及 |
| 2 | BasedOnShape.events: string[] (u64 decimal) | helper `buildBasedOn` 経由で自動 |
| 3 | sentinel runtime closed loop (`"multi:disabled"`) | `getSessionId` + `causedByProjector` の closed loop 設計を維持 |
| 4 | causal window 境界 (frontier check + monotonic timeout) | `buildCausedBy` + `buildBasedOn` 内で自動 |
| 5 | `desktop-state.ts` module-scope wiring (run_macro 経路維持) | PR #112 shared registration handler pattern 各 tool で踏襲 |

trunk lock layer (= expansion で touch 禁止):
- `crates/engine-perception/**/*.rs` (Rust dataflow + view + worker)
- `src/l1_capture/**/*.rs` (Rust L1 ring buffer + payload + napi)
- `src/l3_bridge/**/*.rs` (Rust L3 bridge: focus_pump / dirty_rect_pump / mod)
- `src/engine/perception/**/*.ts` (TS perception envelope)

これらは expansion-pr-guard.yml + check-expansion-disjoint.mjs で **CI + ローカル 2 重 pin**。

---

## 2. 7 swimlane × worktree 並走戦略

### 2.1 swimlane 定義 + 着手 priority

| # | swimlane | scope | 着手 priority | 想定 PR 数 | 並走可否 | Rust touch |
|---|---|---|---|---|---|---|
| 1 | **L5 commit tool wrapper** | mouse_click / keyboard / clipboard / scroll / focus_window / browser_click / browser_fill / browser_form / browser_open / browser_navigate / window_dock / notification_show / terminal_send / workspace_launch / run_macro / mouse_drag / browser_eval (commit dual) / 残 7 commit | **1 (最高)** | 8-10 | ✓ 完全並走可 | なし |
| 2 | **L5 query tool wrapper** | screenshot / browser_overview / browser_locate / browser_search / desktop_discover (S4 既存) / wait_until / workspace_snapshot / server_status / 残 2 query | **2** | 5-7 | ✓ 完全並走可 | なし |
| 3 | **L4 envelope 拡張** | invariants_held (P3) / query_past (P4 link only) / dry-run (P5、predicted_post_state 依存) / working memory (P6) / `confidence` 残 3 値 (`cached` / `inferred` / `stale`) | **3** | 4-5 | △ 順次 (依存関係あり) | なし |
| 4 | **typed reason 残 36 codes** | `_errors.ts::SUGGESTS` を `try_next: TypedAction[]` に進化、ADR-010 P2 acceptance 100% mapping。残 36 codes のうち lease 経路 4 codes (`LeaseGenerationMismatch` / `EntityNotFound` / `LeaseDigestMismatch` / `EntityOutsideViewport`) は trunk pattern コピー | **4** | 4-5 | ✓ 並走可 (code ごと独立) | なし |
| 5 | **L1 secondary monitor** | DXGI dirty rect の secondary monitor subscription / per-monitor aggregate 分離 | **5** | 1-2 | ✓ 並走可 (L1 単独) | あり (`crates/dxgi-bridge` 等、trunk lock 外) |
| 6 | **L1 emit sites** | P5c-3 Window event / P5c-4 Scroll event / P5d timestamp 多重化 | **6** | 3-4 | ✓ 並走可 (L1 内 disjoint) | あり (`src/l1_capture` = trunk lock layer、本来 expansion 範囲外、別 ADR) |
| 7 | **L3 view 拡充** | semantic_event_stream / predicted_post_state | **7** | 2-3 | △ D2-E0 scope は共有 | あり (`crates/engine-perception` = trunk lock layer、別 ADR) |

**注意 (swimlane 5-7)**: 5 (L1 secondary monitor) は ADR-007 P5c-3/4 として別 trunk 工程、6 (L1 emit sites) と 7 (L3 view 拡充) は trunk lock layer 改変必要のため **expansion phase 範囲外**。本書では参考情報として列挙、実着手は別 ADR / 別 walking skeleton で扱う。

### 2.2 swimlane 1-4 が真の expansion 並走対象

trunk lock layer 改変なしで mechanical コピーで進められるのは swimlane 1-4。これらが本書の核心 scope:

- **swimlane 1 (L5 commit)**: 最大波及効果、worktree 3-5 並走で 1-2 週間想定
- **swimlane 2 (L5 query)**: swimlane 1 と同型、worktree 並走で同期間
- **swimlane 3 (L4 envelope)**: 順次 (P3 → P4 → P5 → P6 + confidence 拡張)、約 2 週間
- **swimlane 4 (typed reason)**: 残 36 codes mechanical、worktree 並走で 1 週間

合計工数 (sequential 換算): 4-6 週間、worktree 3-5 並走で 1-2 週間圧縮可能。

---

## 3. 30 分タイムアタック template (1 tool 1 PR)

各 expansion tool wrap PR の標準 workflow:

### 3.1 着手手順

1. **Branch fork**: `feature/expansion-{tool-name}` (例: `feature/expansion-mouse-click`)
2. **registration site で wrap**:
   - commit tool: `makeCommitWrapper(handler, "tool_name", { /* options */ })`
   - query tool: `makeQueryWrapper(handler, "tool_name", { /* options */ })`
   - lease 必須 commit: `leaseValidator` + `extractLeaseToken` を渡す (S4 desktop_act 先例)
   - lease 不在 commit: `leaseValidator` 省略 (S6 click_element 先例)
3. **`{tool}RegistrationSchema` 必須 export** (★ Codex PR #121 P2 + Opus PR #121 P2-1 反映、PR #117 land 後の同型 production bug を仕組みで防止):
   ```typescript
   import { makeCommitWrapper, withEnvelopeIncludeSchema } from "./_envelope.js";

   export const {tool}RegistrationSchema = withEnvelopeIncludeSchema({tool}Schema);
   ```
   この `{tool}RegistrationSchema` を **以下 2 経路の両方で参照する** (片方だけ忘れると `include` arg が silently strip される):
   - `server.tool("{tool}", desc, {tool}RegistrationSchema, {tool}RegistrationHandler)` (MCP server 直接登録)
   - `TOOL_REGISTRY.{tool} = { schema: z.object({tool}RegistrationSchema), handler: {tool}RegistrationHandler ... }` (macro.ts、`run_macro` 経路)

   **Why**: MCP SDK の `server.tool` + `run_macro` 内 `entry.schema.parse(args)` は両方 Zod 経由、Zod object parse は unknown key を strip する。`include` field は base schema に存在しないため、injection なしでは `include:["causal"]` / `include:["envelope"]` が消失し `makeCommitWrapper` の peek+strip が空振りして per-call envelope opt-in が **silently raw fallback** する (PR #112 P1-1 / PR #117 click_element 既存 bug / PR #121 mouse_click Codex P2 と全て同型)。
4. **module-scope export** (`{tool}RegistrationHandler` 命名)、`run_macro` 経路 (`TOOL_REGISTRY.{tool}` in `macro.ts`) も同 instance に切替 (PR #112 shared registration handler pattern、strip risk 防止)
5. **unit test 1 件追加** (envelope shape return + L1 ToolCallStarted/Completed event 確認)
6. **push + PR 起票**:
   - PR title に "expansion" 含有 (例: "expansion: mouse_click commit wrapper")
   - label に `expansion` 付与 (workflow trigger 用)
   - `expansion-pr-guard.yml` が trunk lock layer 改変なしを enforce
7. **Opus 1 round** (trunk pattern conformance 軸) + **Codex 補助 review**
8. **merge** (Opus 指摘ゼロ + Codex P1 ゼロ)

### 3.2 PR description template

```markdown
## Summary

`{tool}` を `make{Commit,Query}Wrapper` で wrap。S6 click_element PoC pattern 準拠 (sub-plan §3 Expansion 並走戦略 + 30 分タイムアタック template)。

## scope

- `src/tools/{file}.ts`: module-scope `{tool}RegistrationHandler` + `{tool}RegistrationSchema = withEnvelopeIncludeSchema({tool}Schema)` export、`server.tool` 3rd arg を `{tool}RegistrationSchema` に切替
- `src/tools/macro.ts`: `TOOL_REGISTRY.{tool}.schema` を `z.object({tool}RegistrationSchema)` に切替 + handler を shared instance に切替
- `tests/unit/{tool}-wrapper.test.ts`: envelope shape return + L1 event 確認 (1 件)

## trunk contract conformance check

- engine-perception layer 改変ゼロ (expansion-pr-guard.yml + check-expansion-disjoint.mjs)
- run_macro 経路同 instance 共有 (PR #112 pattern)
- handler internal logic + Zod schema + 戻り値 shape 不変 (ADR-010 §1.5)
```

---

## 4. merge conflict 防止

### 4.1 共有 file の同時 1 件 rebase 順守

以下の file は trunk で確定 SSOT、expansion で touch する PR は **同時 1 件のみ** (rebase 順守):

- `src/tools/_envelope.ts` (S3-S5 で確立した L5 wrapper helper)
- `src/engine/native-types.ts` (新 binding interface 追加時のみ touch)
- `src/engine/native-engine.ts` (新 binding interface 追加時のみ touch)
- `src/tools/macro.ts` (TOOL_REGISTRY、各 tool wrap で同 file edit が重複)

### 4.2 worktree 並走運用

CLAUDE.md §3.4 (Max 20x 並走戦略) に従い、Sonnet 並列 worktree session 3-5 並走:
- 各 worktree は **独立 swimlane / 独立 tool** を担当
- 共有 file 改変が必要な PR は **rebase 順守 + merge 順序調整** で衝突回避
- Opus は trunk pattern conformance check 専任、各 PR 1 round の lightweight review
- Codex は補助 (任意)、API contract regression 軸で気になる箇所のみ trigger

---

## 5. expansion phase 着手 checklist

S6 trunk completion 後、expansion phase 着手前に以下を確認:

- [ ] S6 PR (本書 + click_element PoC + expansion-pr-guard.yml + check-expansion-disjoint.mjs + ADR-008 D2-G 部分着手) が main merge 済み
- [ ] expansion-pr-guard.yml が main で 1 度起動確認 (test PR 1 件で expansion label + crates/engine-perception 改変 → fail を確認)
- [ ] check-expansion-disjoint.mjs を `npm run check:expansion-disjoint` で動作確認 (本 PR で実証済)
- [ ] swimlane 1 (L5 commit) で 1 件目の expansion PR (例: mouse_click) を起票、30 分タイムアタック template 通り進行
- [ ] Opus 1 round + Codex 補助で merge、pattern conformance 確認
- [ ] swimlane 1 で 2-3 件 merge 後、worktree 3-5 並走に移行 (Sonnet sessions 立ち上げ)

---

## 6. carry-over (本書 scope 外、ADR-011 等で扱う)

- **ADR-008 D2-G 完全完了**: semantic_event_stream / predicted_post_state view (本 S6 で部分着手のみ、完全完了は別 PR)
- **ADR-011 Cognitive Memory Taxonomy**: working/episodic/semantic/procedural memory + multi-session session_id source finalize + history buffer 永続化
- **ADR-009 HW Acceleration Plane**: Tier 0-3 dispatch 統一規約の expansion 適用

---

## Appendix A: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Drafted v0.1 | 2026-05-01 | Claude (Sonnet) | 初稿起草、walking skeleton expansion phase の worktree 並走戦略 + 7 swimlane priority + 30 分タイムアタック template + merge conflict 防止 + expansion phase 着手 checklist。S6 sub-plan PR #116 §1.1 D + walking-skeleton §6 整合 (新規起草、事前 fork 不在を実 repo 確認) |
