# walking skeleton S6 / G6 alignment (trunk completion 判定 + CI assert 化 + expansion plan 起草)

- Status: **Drafted (2026-05-01)**
- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 **S6** (line 280-296) + §5 完了基準 (line 322-333) + §5.1 中間見直しゲート + §5.2 永続化 + Appendix C ゲート判定ログ
- Trigger: walking skeleton **S5 (PR #115 merged 2026-05-01、commit `40ceadf`)** 完了後の **trunk 完成判定 + 仕組み化** PR。S6 で trunk 完了判定 (= expansion tool 1 件追加が L5 wrapper 修正のみで完了することの実証 + CI assert 化) → expansion phase 着手の根拠が確定する
- 親 plan: `docs/walking-skeleton-trunk-selection.md` §4 S6 (line 280-296) + §4.1 line 307 (S6 工数 2 日 / Opus 1 round / Codex - 補助) + §5 完了基準 #1 (CI assert 化、line 326)
- 概念設計:
  - CLAUDE.md §7 (仕組みで対応する) — 人間 git diff 運用ではなく CI assert で機械的強制
  - CLAUDE.md §3.4 (Max 20x 並走戦略) — expansion phase で worktree 並走最大化
  - `docs/walking-skeleton-trunk-selection.md` §6 (Expansion 並列化計画) — 7 swimlane × 3-5 worktree 並走戦略
- 並走依存: 本 S6 sub-plan PR は **PR #115 (S5 impl) merged が前提条件**、S5 で確立した 5 構造的 contract (CausedByShape 4 field + envelope top-level BasedOnShape + sentinel runtime closed loop + monotonic timeout + desktop-state.ts wiring) が S6 PoC の起点
- 対象 sub-batch: walking skeleton **S6 (PR ?)** — expansion 候補 tool 1 件 (`click_element` lease 不在 commit バリエーション) PoC + `.github/workflows/expansion-pr-guard.yml` 新設 + `docs/walking-skeleton-expansion-plan.md` 起草 + ADR-008 D2-G 部分着手 + Appendix C G6 entry append
- 後続: **expansion phase** (S6 完了後、worktree 並走で 24+10 tool wrapper 化 + typed reason 残 49 codes + dry-run integration、長期作業で完了に数週間想定)

---

## 0. walking skeleton S6 位置付け note

本 sub-plan は walking skeleton trunk **完成判定 PR**。S5 で確立した 5 構造的 contract (= trunk lock) が **「expansion tool 1 件追加が L5 wrapper の修正のみで完了する」** という仕組み的観察可能な性質を持つことを **CI assert で機械的に強制**することで trunk 完了を pin する。本 S6 は trunk 内の最後 sub-batch:

- S1 (PR-η D2-E0 完了): dataflow scope refactor
- S2 (PR-ε D2-C 完了): count-only `dirty_rects_aggregate`
- S3 (PR #110 envelope skeleton 完了): envelope minimal wrapper + compat mode + size SLO bench
- S4 (PR #113 merged): commit 軸 wrapper + lease 4-tuple validation + ToolCallStarted/Completed payload schema 確定
- S5 (PR #115 merged 2026-05-01、commit `40ceadf`、最重要 contract): caused_by linkage cross-layer
- **S6 (★ 本 PR)**: trunk completion 判定 + CI assert + expansion plan 起草

S6 は **TS + workflow yaml + docs 中心 PR、Rust touch なし**。Walking skeleton §4.1 line 307 整合: 工数 **2 日 / Opus 1 round / Codex 補助**。

**G6 ゲートの目標** (`docs/walking-skeleton-trunk-selection.md` §5 完了基準 #1 line 326 + §4 S6 完了基準 line 291-294):

| # | walking-skeleton §4/§5 S6 目標 | 本 sub-plan 検証手段 |
|---|---|---|
| 1 | expansion 候補 tool 1 件 (`click_element` lease 不在 commit バリエーション) を pattern コピーで動作させた PoC を含める | §3.1 click_element wrap + §3.6 contract test 1 件 |
| 2 | expansion plan doc (`docs/walking-skeleton-expansion-plan.md`) が main にある | §3.4 expansion plan doc 起草 |
| 3 | CI guard が main で動作 (PR test で expansion label 付き PR が engine-perception 改変ありで fail) | §3.2 expansion-pr-guard.yml 新設 + §3.7 自己検証 |
| 4 | trunk 完了判定 = expansion tool 追加が L5 wrapper 修正のみで完了することの仕組み的強制 | §3.2 + §3.8 G6 判定 + Appendix C append |

**review 観点の再定義**: 本 PR は「expansion 完成度」ではなく **「trunk 完了判定が CI で機械的に強制される + expansion phase 着手の根拠が確定する」** で評価。

---

## 1. Scope (trunk / expansion / carry-over の 3 分類)

### 1.1 [S6 trunk] 本 sub-plan で扱う (G6 contract 必須)

A. **`click_element` を `makeCommitWrapper` で wrap** (lease 不在 commit バリエーション、sub-plan §1.1 G で trunk scope 外と明示済 = expansion で実施するパターンの **30 分タイムアタック PoC**):
  - 既存 `click_element` handler 不変、registration site で `makeCommitWrapper(handler, "click_element", { /* leaseValidator omitted */ })` 経由
  - `getSessionId` は default `() => "default"` で OK (lease 不在のため args から resolve 不可)
  - `argsSummary` は default `truncateJson` で OK
  - L1 ToolCallStarted/Completed event は `lease_token: undefined` で push される (S4 既存 contract 通り)

B. **`.github/workflows/expansion-pr-guard.yml` 新設** (CI assert 化、CLAUDE.md §7 仕組みで対応):
  - PR title or label に `expansion` 含有検出時、**TRUNK_LOCK_PATHS = 4 path** に対する diff を実行 (§2.1 yaml + §2.2 script で **bit-equal sync** 必須):
    1. `crates/engine-perception/**/*.rs` (Rust dataflow + view + worker)
    2. `src/l1_capture/**/*.rs` (Rust L1 ring buffer + payload + napi)
    3. `src/l3_bridge/**/*.rs` (Rust L3 bridge: focus_pump / dirty_rect_pump / mod)
    4. `src/engine/perception/**/*.ts` (TS perception envelope、ADR-008 D2 で確定済)
  - 上記 path に **non-doc 行 (Rust + TS)** が 1 行でも含まれていれば CI fail (= trunk 違反 = engine-perception 層 wrap で済まない expansion はバグ)
  - `*.md` exclude
  - workflow は本 PR で起草、main merge 後 expansion 着手時点で運用開始
  - **重要 (Round 2 P1 反映)**: §1.1 B / §2.1 yaml / §2.1 列挙 / §2.2 script の 4 箇所で path 列挙を **bit-equal sync** (Round 1 Opus P1-1 で 4 箇所 fact 食違い + 実 repo 不在 path 検出、PR #99 同型 fact divergence 防止)

C. **`scripts/check-expansion-disjoint.mjs` 新設** (ローカル equivalent、push 前 6-guard 拡張):
  - workflow と同 logic、ローカルで pre-push hook (`scripts/install-hooks.mjs` 経由) または手動 `npm run check:expansion-disjoint` で実行可能
  - workflow + ローカル双方で重複 enforce、CI assert を main 経路の最終防衛とし、ローカル check が早期 detect

D. **`docs/walking-skeleton-expansion-plan.md` 新規起草** (本書の続編、tool ごとの worktree 並走計画):
  - **Round 2 P3-1 fix (Opus Round 1)**: walking-skeleton §6.3 line 381 に「trunk 直系で Sonnet を遊ばせず、別 Sonnet session を並走で動かす」「`docs/walking-skeleton-expansion-plan.md` の事前起草」と書かれているが、**現時点 main に file 不在** (実 repo 確認: `Glob docs/walking-skeleton-expansion-plan.md` → No files)。本 S6 PR は **新規起草** (事前起草 fork が存在しないため finalize ではなく初稿)、別 Sonnet 並走 fork は今回未利用
  - 7 swimlane (L1 emit / L3 view / L5 commit / L5 query / L4 envelope / typed reason / L1 secondary monitor) と 3-5 worktree 並走戦略 (`docs/walking-skeleton-trunk-selection.md` §6.1)
  - tool ごとの 1 PR / 30 分タイムアタック template (本 S6 PoC を pattern として記述)
  - merge conflict 防止: `_envelope.ts` (trunk で確定) を expansion で touch する PR は同時 1 件のみ rebase 順守 (sub-plan §6.2)
  - swimlane 着手 priority: L5 commit (最も波及効果高) → L5 query → L4 envelope (P3 invariants) → typed reason 残 49 codes → L1 secondary monitor → L1 emit → L3 view 拡充

E. **G6 ゲート判定 + Appendix C append** — `docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に G6 entry append (本 sub-plan §3.8、impl PR merge 後 commit hash 追記)

### 1.2 [expansion] G6 通過後の expansion phase で実装 (本 PR scope 外)

trunk 完了 (G6 通過) 後の expansion phase で実装:

- **残 ~24 commit tool wrapper 化** (mouse_click / keyboard / clipboard / scroll / focus_window / browser_click 等): `makeCommitWrapper` mechanical コピー、本 S6 click_element PoC を pattern として
- **残 ~10 query tool wrapper 化** (screenshot / browser_overview / browser_locate 等): `makeQueryWrapper` mechanical コピー (S5 で確立した causedByProjector option は L5 wrapper level、view 共有コスト極小)
- **typed reason 残 49 codes** (ADR-010 §5.4): `_errors.ts::SUGGESTS` を `try_next: TypedAction[]` に進化、ADR-010 P2 acceptance criteria 100% mapping
- **dry-run integration** (`if_you_did` field): ADR-010 P5 work、副作用大の tool に `dry_run=true` 引数経由で `predicted_post_state` view 経由 preview return
- **`include=working:N` / `episodic:N`** (ADR-010 P6): 直近 N event compact / 直近 N tool call history、本 S5 は include=causal 単独
- **`include=invariants`** (ADR-010 P3 後半): invariants_held projection
- **`include=time_travel`** (ADR-010 P4 default-on): query_past link、ADR-008 D3 完了後

### 1.3 [carry-over] §3.bis ledger / OQ で永続化 (別 phase)

- **OQ #1 — ADR-008 D2-G 部分着手**: 本 trunk で確定した 5 view (current_focused_element / latest_focus / dirty_rects_aggregate / focus_pump pipeline / lease store) の docs 整合 update。完全 D2-G 完了は expansion phase で
- **OQ #2 — `_post.ts` (perception envelope + history ring buffer) と新 `_envelope.ts` の役割境界 final**: S5 で「両者共存、`_post.ts::recordHistory` touch なし」採用済 (PR #114 OQ #5 + #7)、完全統合は ADR-011 (Cognitive Memory Taxonomy) work
- **OQ #3 — `getMcpTransportSessionId()` finalize**: S5 で stub `() => undefined` 採用済、ADR-011 で MCP transport context 由来 session_id schema 確定
- **OQ #4 — `_historyBuffers` LRU eviction parameter tune**: 本 trunk 1k entry / TTL 24h で skeleton 段階十分、production load testing で再 tune は expansion

### 1.4 北極星整合 + walking skeleton G6 contract

- **N1 (pivot 必ず保持)**: trunk completion 判定は CI assert (workflow yaml) + ローカル script で 2 重 pin、人間 git diff 運用に依存しない (`docs/walking-skeleton-trunk-selection.md` §5 完了基準 #1)
- **CLAUDE.md §7 (仕組みで対応)**: trunk 完成 = 「expansion tool 追加が L5 wrapper 修正のみ」を機械的強制で pin、メモリ運用 / 人間 review 運用に頼らない
- **CLAUDE.md §3.4 (Max 20x 並走戦略)**: expansion phase で worktree 3-5 並走、Sonnet 並列度最大化、Opus は trunk pattern conformance check 専任
- **walking skeleton G6 contract**: 「click_element wrap で動く」+「engine-perception 層 0 行改変」+「expansion plan doc 永続化」の 3 軸が **本 PR で同時達成** = trunk 完了判定の根拠

---

## 2. 設計判断

### 2.1 expansion-pr-guard.yml の判定 logic

```yaml
# .github/workflows/expansion-pr-guard.yml (新設)
name: Expansion PR Guard

on:
  pull_request:
    types: [opened, edited, synchronize, labeled, unlabeled]

jobs:
  expansion-disjoint-check:
    runs-on: ubuntu-latest
    if: contains(github.event.pull_request.labels.*.name, 'expansion') || contains(github.event.pull_request.title, 'expansion')
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Check engine-perception layer is untouched
        run: |
          DIFF=$(git diff --name-only origin/${{ github.base_ref }}...HEAD -- \
            'crates/engine-perception/**/*.rs' \
            'src/l1_capture/**/*.rs' \
            'src/l3_bridge/**/*.rs' \
            'src/engine/perception/**/*.ts')
          if [ -n "$DIFF" ]; then
            echo "::error::expansion PR modified engine-perception layer (trunk violation):"
            echo "$DIFF"
            exit 1
          fi
          echo "engine-perception layer untouched (trunk contract preserved)"
```

**判定 path** (trunk lock layer = expansion で touch 禁止、Round 2 P1 fix で実 repo 構造と整合):
- `crates/engine-perception/**/*.rs` (Rust dataflow + view + worker、ADR-008 D1〜D2 で確定)
- `src/l1_capture/**/*.rs` (Rust L1 ring buffer + payload + napi、ADR-007 P5a〜P5c で確定)
- `src/l3_bridge/**/*.rs` (Rust L3 bridge: focus_pump / dirty_rect_pump / mod、ADR-008 D1-2 + D2-C で確定)
- `src/engine/perception/**/*.ts` (TS perception envelope + hot-target-cache + target-timeline 等、ADR-008 D2-B-2 で確定)

**判定 path 外** (expansion で touch OK):
- `src/tools/**` (L5 wrapper、各 tool individual implementation)
- `src/engine/native-engine.ts` / `src/engine/native-types.ts` (TS interface、新 binding 露出)
- `tests/unit/**` (test 追加)
- `docs/**` (docs 更新)
- `benches/**` (bench 追加)

### 2.2 `scripts/check-expansion-disjoint.mjs` ローカル equivalent

```typescript
#!/usr/bin/env node
// scripts/check-expansion-disjoint.mjs
// Pre-push hook + manual `npm run check:expansion-disjoint` 経由で trunk lock layer の expansion 改変を検出。

import { execSync } from "node:child_process";

// Round 2 P1 fix (Opus Round 1 P1-1): bit-equal sync with §1.1 B + §2.1 yaml.
// Path list 4 件は実 repo 構造と整合 (`Glob` で存在確認済、PR #99 同型
// fact divergence 防止)。
const TRUNK_LOCK_PATHS = [
  "crates/engine-perception/",
  "src/l1_capture/",
  "src/l3_bridge/",
  "src/engine/perception/",
];

function isExpansionPr() {
  // GitHub Actions 経由 (PR title/label) or local commit message から expansion 検出
  // ローカル運用では commit message に "expansion" キーワード含有で trigger
  const headRef = process.env.HEAD_REF || "";
  const commitMsg = execSync("git log -1 --pretty=%s", { encoding: "utf8" });
  return /\bexpansion\b/i.test(headRef) || /\bexpansion\b/i.test(commitMsg);
}

if (!isExpansionPr()) {
  console.log("[check-expansion-disjoint] Not an expansion branch — skip.");
  process.exit(0);
}

const baseRef = process.env.BASE_REF || "origin/main";
const diff = execSync(`git diff --name-only ${baseRef}...HEAD`, { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const violations = diff.filter((path) =>
  TRUNK_LOCK_PATHS.some((p) => path.startsWith(p)),
);

if (violations.length > 0) {
  console.error("[check-expansion-disjoint] Expansion PR modified trunk lock layer:");
  for (const v of violations) console.error(`  ${v}`);
  console.error("Trunk contract requires expansion to touch only L5 wrapper / TS interface / tests / docs.");
  console.error("Either narrow scope to L5 wrapper layer, or remove the 'expansion' marker if this PR is properly an engine-perception change.");
  process.exit(1);
}

console.log(`[check-expansion-disjoint] OK — expansion PR untouched ${TRUNK_LOCK_PATHS.length} trunk lock paths.`);
```

`package.json` の `scripts` に `check:expansion-disjoint` 追加 + push 6-guard に編入は **expansion phase 着手時に user 判断**で運用開始 (本 trunk 着手前は trunk 自体の改変が不可避のため off)。

### 2.3 `click_element` wrap PoC (lease 不在 commit、30 分タイムアタック)

**Round 2 P2-1 fix (Opus Round 1)**: 実際の `click_element` handler 場所は `src/tools/ui-elements.ts` (`registerClickElementTool` line 361 + `clickElementHandler` line 90)、`src/tools/click-element.ts` 単独 file は不在。本 PoC は **既存 `src/tools/ui-elements.ts` の registration site で wrap** する。

```typescript
// src/tools/ui-elements.ts (line 361 周辺、registration site)
// 既存:
//   server.tool("click_element", desc, schema,
//     withRichNarration("click_element", clickElementHandler, { windowTitleKey: "windowTitle" }))
// 本 S6 で wrap:
import { makeCommitWrapper } from "./_envelope.js";

// module-scope export で run_macro 経路 (`TOOL_REGISTRY.click_element`) と shared instance
export const clickElementRegistrationHandler = makeCommitWrapper(
  withRichNarration("click_element", clickElementHandler, { windowTitleKey: "windowTitle" }),
  "click_element",
  {
    // leaseValidator omitted = lease-less commit variant (sub-plan §1.1 G、
    // walking-skeleton §4 line 244 で trunk scope 外明記、本 S6 PoC で実証)
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

// server.tool("click_element", desc, schema, clickElementRegistrationHandler);
```

**withRichNarration との合成順序**: `withRichNarration` は handler の **戻り値拡張** (`hints.diff` 等)、`makeCommitWrapper` は **lifecycle 管理** (L1 push + envelope wrap)。順序は **`withRichNarration` 内側 → `makeCommitWrapper` 外側** で、commit wrapper が `withRichNarration` 拡張済 ToolResult を envelope 化する形。`run_macro` 経路 (`TOOL_REGISTRY.click_element`) も同 instance 共有 (PR #112 shared registration handler pattern 整合)。

**完了基準**: 既存 e2e test 無修正 pass + envelope shape return + L1 ToolCallStarted/Completed event 記録 + `caused_by.your_last_action = "click_element(...)"` を `desktop_state(include=causal)` で確認 (= 30 分タイムアタックの定量目標)。

### 2.4 `docs/walking-skeleton-expansion-plan.md` 起草 outline

```markdown
# Walking skeleton expansion plan (post-trunk)

- Status: Drafted (本 S6 で起草)
- Trigger: walking-skeleton trunk completion (S6 G6 通過、PR #?)
- 上位戦略: docs/walking-skeleton-trunk-selection.md (Proposed v0.4) §6 Expansion 並列化計画

## 1. Expansion phase 構造

trunk で確立した 5 構造的 contract:
1. CausedByShape 4 field + envelope top-level BasedOnShape (architecture §8.2 整合)
2. BasedOnShape.events: string[] u64 decimal
3. sentinel runtime closed loop
4. causal window 境界 (frontier check + monotonic timeout)
5. desktop-state.ts module-scope wiring (run_macro 経路維持)

これを mechanical コピーで全 expansion tool に波及させる。

## 2. 7 swimlane と worktree 並走戦略

| swimlane | scope | 着手 priority | 想定 PR 数 | 並走可否 |
|---|---|---|---|---|
| L5 commit tool wrapper | mouse_click / keyboard / clipboard / scroll / focus_window / browser_click 等 | 1 | 8-10 | ✓ 並走可 |
| L5 query tool wrapper | screenshot / browser_overview / browser_locate 等 | 2 | 5-7 | ✓ 並走可 |
| L4 envelope 拡張 | invariants_held (P3) / query_past (P4) / dry-run (P5) | 3 | 4-5 | △ 順次 (依存) |
| typed reason 残 49 codes | _errors.ts SUGGESTS 連動 | 4 | 4-5 | ✓ 並走可 |
| L1 secondary monitor | DXGI dirty rect secondary monitor subscription | 5 | 1-2 | ✓ |
| L1 emit sites | P5c-3 Window event / P5c-4 Scroll event / P5d timestamp 多重化 | 6 | 3-4 | ✓ |
| L3 view 拡充 | semantic_event_stream / predicted_post_state | 7 | 2-3 | △ D2-E0 scope 共有 |

## 3. 30 分タイムアタック template (1 tool 1 PR)

1. Branch fork (feature/expansion-{tool-name})
2. registration site で `makeCommitWrapper` または `makeQueryWrapper` 経由 wrap
3. unit test 1 件追加 (envelope shape return 確認)
4. push + PR 起票 (PR title に "expansion" 含有 = guard 起動)
5. expansion-pr-guard.yml 確認、Opus 1 round (trunk pattern conformance) + Codex (mechanical コピー軸)
6. merge

## 4. merge conflict 防止

- `src/tools/_envelope.ts` (trunk で確定 SSOT) を expansion で touch する PR は **同時 1 件のみ** (rebase 順守)
- `src/engine/native-types.ts` も同等 (新 binding interface 追加時のみ touch)
```

### 2.5 ADR-008 D2-G 部分着手 (本 trunk で確定した分の docs 整合)

`docs/adr-008-d2-plan.md` (D2-G section) または新 `docs/adr-008-d2-g-trunk-completion.md` を起草:
- trunk で確定した view 5 件 (`current_focused_element` / `latest_focus` / `dirty_rects_aggregate` / `focus_pump pipeline` / `lease store`) の最終 status update
- D2-E0 dataflow scope refactor の closure
- 残 D2-G expansion 範囲 (semantic_event_stream / predicted_post_state) は expansion phase carry-over

完全 D2-G 完了は expansion phase で別 PR、本 S6 では status update のみ。

---

## 3. 実装 sub-batch (本 PR 内、S6 trunk scope)

### 3.1 S6-1: click_element wrap PoC (~30 line) [S6 trunk]

**Round 2 P2-1 fix (Opus Round 1)**: 実際の click_element handler 場所は `src/tools/ui-elements.ts` (`clickElementHandler` line 90 + `registerClickElementTool` line 361)、`src/tools/click-element.ts` 単独 file は不在。本 sub-batch は `ui-elements.ts` を編集する。

- [ ] `src/tools/ui-elements.ts` (実際の click_element handler / registration 場所):
  - [ ] module-scope `clickElementRegistrationHandler = makeCommitWrapper(withRichNarration(...), "click_element", { /* leaseValidator omitted */ })` export
  - [ ] handler internal logic + Zod schema + 戻り値 shape **不変** (ADR-010 §1.5)
  - [ ] `registerClickElementTool` 内の `server.tool` 呼出を `clickElementRegistrationHandler` 経由化
- [ ] `src/tools/macro.ts`: `TOOL_REGISTRY.click_element` を module-scope wrapped instance に切替 (PR #112 shared registration handler pattern、strip risk 防止)

### 3.2 S6-2: expansion-pr-guard.yml + check-expansion-disjoint.mjs (~80 line) [S6 trunk]

- [ ] `.github/workflows/expansion-pr-guard.yml` 新設 (§2.1)
- [ ] `scripts/check-expansion-disjoint.mjs` 新設 (§2.2)
- [ ] `package.json` `scripts` に `check:expansion-disjoint` 追加
- [ ] 自己検証: 本 PR が `expansion` label/title 持たないため fail しない、test PR (別 dummy) で expansion label + crates/engine-perception 改変 → fail を確認

### 3.3 S6-3: walking-skeleton-expansion-plan.md 起草 (~200 line) [S6 trunk]

- [ ] `docs/walking-skeleton-expansion-plan.md` 新設 (§2.4 outline ベース)
- [ ] 7 swimlane × priority + worktree 並走 + 30 分タイムアタック template + merge conflict 防止

### 3.4 S6-4: ADR-008 D2-G 部分着手 (~50 line) [S6 trunk]

- [ ] `docs/adr-008-d2-plan.md` (or 新設 `adr-008-d2-g-trunk-completion.md`) で trunk 確定 view 5 件の status update
- [ ] 残 D2-G expansion (semantic_event_stream / predicted_post_state) は expansion phase carry-over 明記

### 3.5 S6-5: contract test (~30 line) [S6 trunk]

- [ ] `tests/unit/click-element-commit-wrapper.test.ts` 新設 (S6-1 click_element wrap PoC の動作確認):
  - [ ] **G6-S6-1**: click_element 経由 → makeCommitWrapper flow 通過、L1 ToolCallStarted/Completed event 記録 (lease_token: undefined で push)
  - [ ] **G6-S6-2**: 既存 raw client 互換 (compat hoist で raw shape return、include 未指定時 envelope 不在)
  - [ ] **G6-S6-3**: include=["causal","envelope"] 経由 → caused_by.your_last_action = "click_element(...)" が後続 desktop_state で展開

### 3.6 S6-6: 検証 [S6 trunk]

- [ ] `npm run build` (tsc) clean
- [ ] `npm test` (vitest unit): regression 0
- [ ] `npm run check:expansion-disjoint` (新規追加): 本 PR は expansion label なしで skip
- [ ] 6-guard 全 pass (napi-safe / native-types / stub-catalog / build / lint / cargo)

### 3.7 S6-7: G6 ゲート判定 + Appendix C append (~5 line) [S6 trunk]

- [ ] `docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に G6 entry append (本 PR で同梱、Round 2 P2-2 fix で trunk lock paths 4 件明記):
  ```markdown
  | G6 | 2026-05-XX | 完了 | walking skeleton trunk completion: click_element lease 不在 commit wrap PoC (`src/tools/ui-elements.ts`) + expansion-pr-guard.yml + check-expansion-disjoint.mjs ローカル equivalent (TRUNK_LOCK_PATHS = `crates/engine-perception/` + `src/l1_capture/` + `src/l3_bridge/` + `src/engine/perception/` の 4 path、bit-equal sync) + walking-skeleton-expansion-plan.md 起草 + ADR-008 D2-G 部分着手 (trunk 確定 5 view status update)。trunk 完了判定 = expansion tool 追加が L5 wrapper 修正のみで完了することの仕組み的強制を CI + local 2 重 pin、worktree 並走 expansion phase 着手の根拠確定 | (なし、expansion phase へ進行) |
  ```

### 3.8 S6-8: PR 起票 + Opus + Codex review loop [S6 trunk]

- [ ] **Opus phase-boundary review Round 1** (CLAUDE.md §3.3 Step 1): 1 round 想定 (walking-skeleton §4.1 line 307)
- [ ] **Codex re-review Round 1** (補助、必須ではない、CLAUDE.md §3.3 Step 2): trunk pattern conformance 軸
- [ ] Opus + Codex 指摘ゼロまで反復、user reviewer 補正 window
- [ ] User 承認 → merge → expansion phase 着手

---

## 4. 対 Opus 単独判断盲点 sweep (Lesson 1-4 防御)

### 4.1 Lesson 1: trunk completion 判定が CI で機械的か

- [ ] expansion-pr-guard.yml の判定 path (crates/engine-perception/ 等) が **trunk lock layer と bit-equal** か、`docs/walking-skeleton-trunk-selection.md` §6.2 (`_envelope.ts` 共有制約) と整合するか

### 4.2 Lesson 2: workflow yaml の syntax error が CI 起動段で検出できるか

- [ ] `.github/workflows/expansion-pr-guard.yml` を YAML lint で確認、test PR で `if` 条件が正しく trigger するか確認

### 4.3 Lesson 3: 順序矛盾 (S5 → S6 → expansion)

- [ ] S6 sub-plan PR は S5 impl PR #115 merged 後の直列順序、本 sub-plan §0 で明示済

### 4.4 Lesson 4: numeric count sync

- [ ] §3 sub-batch 数 (S6-1〜S6-8 = **8 件**)、size 想定 (~400 line / 2 日 = walking-skeleton §4.1 line 307 整合)、expansion plan 7 swimlane が本 sub-plan + walking-skeleton §6.1 で bit-equal

### 4.5 既存 caller 破壊なし

- [ ] click_element wrap で既存 e2e test 無修正 pass (lease 不在 commit variant、`leaseValidator` omitted で skip path)
- [ ] expansion-pr-guard.yml は既存 PR (本 PR 含む) に影響なし (label/title 検出時のみ起動)

---

## 5. PR 切り方

**1 PR で land**、sub-batch 分割しない (click_element PoC + workflow + script + plan doc + D2-G 整合 + test + Appendix C が 1 つの trunk completion 判定として完結)。**Opus 1 round 想定** (walking-skeleton §4.1 line 307) + **Codex 補助 review** (任意)。

size 想定: **~400 line** (TS ~30 + workflow yaml ~40 + script ~80 + expansion plan ~200 + D2-G docs ~50 + test ~30 + Appendix C ~5)。

---

## 6. follow-up (carry-over、§3.bis ledger / OQ で永続化)

- **expansion phase**: 24 commit + 10 query tool wrapper 化 (worktree 並走、本 S6 click_element PoC を pattern として)
- **typed reason 残 49 codes**: ADR-010 P2 work
- **dry-run integration**: ADR-010 P5 work
- **OQ #1 ADR-008 D2-G 完全完了**: expansion phase で別 PR (semantic_event_stream / predicted_post_state)
- **OQ #2 _post.ts 統合**: ADR-011 work

---

## 7. Risks / Mitigation

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | expansion-pr-guard.yml の判定 path が広すぎ / 狭すぎで運用阻害 | 中 | §2.1 path 列挙を `docs/walking-skeleton-trunk-selection.md` §6.2 と bit-equal sync、user judgment で個別 expansion PR の `expansion` label off で bypass 可能 (label removal で workflow skip) |
| R2 | click_element wrap PoC が e2e test で fall back path (UIA timeout 等) で失敗、trunk completion 判定が偽陰性 | 低 | unit test G6-S6-1〜3 で wrapper flow 単体 pin、e2e は CI で別 trigger |
| R3 | walking-skeleton-expansion-plan.md の swimlane priority が運用乖離 (実 expansion で順序変更必要) | 低 | doc は plan、運用乖離は user judgment で更新 PR、permanent record としては意図 |
| R4 | ADR-008 D2-G 部分着手で完了範囲を読み違え、expansion phase に carry-over した方が良い content を本 PR に詰める | 低 | trunk 確定 view 5 件の status update のみに scope 限定、expansion phase 範囲明記 |
| R5 | check-expansion-disjoint.mjs を push 6-guard に編入したら trunk impl PR が fail して merge 不能 | 中 | **expansion 着手時点 (post-merge)** で運用開始、本 PR 段階は manual `npm run check:expansion-disjoint` のみ、6-guard 編入は user judgment |
| R6 | expansion-pr-guard.yml が `expansion` keyword を含む S5/S6 PR title (例: 「S6 + expansion plan 起草」) で誤起動 | 中 | label-based detection を primary に、title detection は補助、本 PR title に "expansion" 含めるが label `expansion` 不付与で workflow skip |

---

## 8. Open Questions (S6 trunk-relevant、3 件)

| # | OQ | 決定タイミング | 推奨 |
|---|---|---|---|
| 1 | `expansion` label 命名 (vs `phase:expansion`、`scope:expansion` 等) | 本 PR で確定 | **`expansion` 単独** で十分、命名 collision risk 低 |
| 2 | `check-expansion-disjoint` を push 6-guard 編入するか expansion phase 着手時に user 判断か | 本 PR 起票時 | **expansion phase 着手時 user 判断** (trunk impl PR の偽陽性回避) |
| 3 | ADR-008 D2-G 部分着手は本 PR で docs only か、別 PR で D2-G 完全完了 PR で扱うか | 本 PR で確定 | **本 PR docs only** (status update のみ)、完全 D2-G 完了は expansion phase carry-over |

---

## 9. walking skeleton + ADR-010 P1 全体図 (本 PR の位置づけ)

```
Walking skeleton trunk:
┌──────────────────────────────────────────────────────────────────────┐
│  S1 (PR-η D2-E0):  dataflow scope refactor                ✅ merged  │
│      ↓                                                                │
│  S2 (PR-ε D2-C):   count-only dirty_rects_aggregate       ✅ merged  │
│      ↓                                                                │
│  S3 (PR #110):     envelope minimal wrapper + compat mode  ✅ merged │
│      ↓                                                                │
│  S4 (PR #113):     commit/query 軸 wrapper +              ✅ merged │
│                    lease 4-tuple validation +                          │
│                    ToolCallStarted/Completed payload schema 確定       │
│      ↓                                                                │
│  S5 (PR #115、最重要 contract):  caused_by linkage         ✅ merged │
│       cross-layer (desktop_act → desktop_state)                        │
│      ↓                                                                │
│  S6 (★ 本 PR):  trunk completion 判定 + CI assert +                  │
│                  expansion plan 起草                                  │
│      ↓                                                                │
│  expansion phase (worktree 並走、24+10 tool + typed reason 残 49 +    │
│                    dry-run + working/episodic memory)                 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 10. References

- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 S6 (line 280-296) + §4.1 line 307 + §5 完了基準 (line 322-333) + §5.1 中間見直しゲート + §5.2 永続化 + §6 Expansion 並列化計画 (line 354-390) + Appendix C ゲート判定ログ
- 概念設計: CLAUDE.md §3.4 (Max 20x 並走) + §7 (仕組みで対応) + §3.1 (複数表 fact 整合)
- 並走依存: PR #115 (S5 impl merged 2026-05-01、commit `40ceadf`) で確立した 5 構造的 contract
- 既存実装: `src/tools/_envelope.ts` (S3-S5 で確立した L5 wrapper) + `src/tools/ui-elements.ts` (`clickElementHandler` line 90 + `registerClickElementTool` line 361、本 S6 で wrap、Round 2 P2-1 fix で `src/tools/click-element.ts` 単独 file 不在を訂正)
- governance: CLAUDE.md 強制命令 3 + 3.3 + 3.4 + 7 + 8 + 9
- 同型先例:
  - sub-plan 構造: PR #103 (S2) + PR #104 (S1) + PR #110 (S3) + PR #111 (S4) + PR #114 (S5) — 3 分類 trunk/expansion/carry-over
  - L5 wrapper helper 設計: PR #110 S3 で `makeEnvelopeAware` 確立、PR #113 S4 で `makeCommitWrapper`/`makeQueryWrapper` 拡張、PR #115 S5 で causedByProjector 拡張、本 S6 で click_element wrap (lease 不在 commit) で expansion 整合

---

## Appendix A: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Drafted v0.1 | 2026-05-01 | Claude (Sonnet) | 初稿起草、walking skeleton S6 sub-plan、trunk completion 判定 + expansion-pr-guard.yml CI assert + check-expansion-disjoint.mjs ローカル equivalent + walking-skeleton-expansion-plan.md 起草 + ADR-008 D2-G 部分着手 + click_element wrap PoC + Appendix C G6 entry。S5 sub-plan PR #114 同型 structure (3 分類 trunk/expansion/carry-over タグ + §0-§10 + Appendix A 改訂履歴 + Lesson 1-4 sweep)、Opus 1 round 想定 (walking-skeleton §4.1 line 307)、Codex 補助 review |
| Drafted v0.3 | 2026-05-01 | Claude (Sonnet) | **Opus Round 2 review 反映** (Conditionally Approved + 新規 P2-N1 のみ): **P2-N1** §10 References line 453 で `src/tools/click-element.ts` 古表記残存、Round 1 P2-1 fix の取りこぼし → Round 3 で `src/tools/ui-elements.ts` (clickElementHandler line 90 + registerClickElementTool line 361) に訂正。Round 1 P1×1 + P2×2 + P3×1 全件は Round 2 で正しく反映済 (5 SSOT bit-equal sync 確認、§3.1 sweep clean、新規 P1 ゼロ)。**Round 2 review iteration ledger**: 本 v0.3 で Opus Round 2 P2-N1 を 1 commit に反映、累積 P1×1 + P2×3 + P3×1、Round 3 Opus 再 review で指摘ゼロ → merge へ |
| Drafted v0.2 | 2026-05-01 | Claude (Sonnet) | **Opus Round 1 review 反映** (Conditionally Approved + P1×1 + P2×2 + P3×1): **P1-1 (致命的)** TRUNK_LOCK_PATHS の 4 箇所 fact 食違い (§1.1 B 4 path / §2.1 yaml + 列挙 3 path / §2.2 script 3 path)、かつ実 repo 構造と不一致 (`src/perception/**`、`src/l3`、`src/l4_envelope` 不在、Rust dataflow 実体は `src/l3_bridge/`、TS perception は `src/engine/perception/`)、結果 CI guard が **常に空 diff = 常時 PASS = silent broken** で trunk 完了判定の北極星 (CLAUDE.md §7) が機能しない致命違反 → Round 2 で **4 path bit-equal sync**: `crates/engine-perception/**/*.rs` + `src/l1_capture/**/*.rs` + `src/l3_bridge/**/*.rs` + `src/engine/perception/**/*.ts`、§1.1 B + §2.1 yaml + §2.1 列挙 + §2.2 script の 4 箇所統一 (PR #99 同型 fact divergence 防止)。**P2-1** `src/tools/click-element.ts` 不在、実体は `src/tools/ui-elements.ts:90 clickElementHandler` + `:361 registerClickElementTool` → §2.3 + §3.1 で訂正、`withRichNarration` (内側) + `makeCommitWrapper` (外側) 合成順序明記、`run_macro` 経路 (`TOOL_REGISTRY.click_element`) shared instance 維持。**P2-2** Appendix C G6 entry に trunk lock paths 4 件明記で trace 永続化。**P3-1** `docs/walking-skeleton-expansion-plan.md` は **新規起草** (事前 fork 不在を実 repo 確認、walking-skeleton §6.3 line 381 「事前起草」想定だが本 PR 着手時点で main 不在のため初稿)。**Round 1 review iteration ledger**: 本 v0.2 で Opus Round 1 P1×1 + P2×2 + P3×1 を 1 commit に反映、Round 2 Opus 再 review 待ち |

---

END OF S6 sub-plan (Drafted v0.3)。
