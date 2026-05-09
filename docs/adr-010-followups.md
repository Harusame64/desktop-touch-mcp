# ADR-010 Follow-ups (post-Phase-6 cleanup)

- Status: **Resolved** (起票 2026-05-09、Phase 7 catalog reconcile PR で fix、live `_errors.ts` 37 codes + ADR-added 12 codes = **49 codes** 全反映、catalog SSOT 本体 1 doc + cascade 8 docs sync 完了)
- 親 ADR: `docs/adr-010-presentation-layer-self-documenting-envelope.md`
- 起票元 PR: #227 (Phase 6 PR-A 6-1/6-2/6-3 dead code dictionary cleanup)
- 解決 PR: #231 (Phase 7 catalog reconcile、本 doc と同 PR で land)

## 1. 趣旨

Phase 6 PR-A の Round 3 Opus review で **ADR-010 §5.4 catalog と現行 `src/tools/_errors.ts` SUGGESTS dictionary の事実乖離** が発見された。memory に書くと揮発する (強制命令 9) ため本 docs に永続記録、別 PR で reconcile する。**Phase 7 で reconcile 完了** (本 doc Status 上部参照)。

---

## 2. ADR-010 §5.4 catalog と live `_errors.ts` の数値乖離

### 2.1 事実

- **ADR-010 §5.4 catalog 主張**: 「既存 23 codes」 (ADR baseline 25 - PR-A 3 + PR-B 1、line 279 / 281、live `_errors.ts` 全 entries とは異なる subset)
- **PR-A merge 前 main HEAD `925ce8b` 時点 `_errors.ts` SUGGESTS**: 39 entries (Phase 5 closure 直後)
- **PR-A merged 時点 (現行 main HEAD `8629de9`)**: 36 entries (-3 で Phase 6 削除完了)
- **PR-B merged 後の見込み**: 37 entries (+1 で AutoGuardBlocked 追加)
- **乖離**: 14 entries が ADR-010 §5.4 catalog に未反映 (`_errors.ts` だけ後追いで追加され、ADR catalog 全面 reconcile が怠られた累積、PR-B AutoGuardBlocked 追加以前から存在)

### 2.2 14 entries の起源 (推定)

Phase 6 削除 3 件 (TerminalMarkerStale / MaxDepthExceeded / LensBudgetExceeded) を除いた現行 `_errors.ts` SUGGESTS のうち、ADR-010 §5.4 line 285-307 + 313-331 列挙にない entries を `git log -L:<entry>:src/tools/_errors.ts` で起源 PR に紐付けると、概ね以下の追加経路:

- Issue #178: `MouseClickNotDelivered` / `MouseDragNotDelivered` (PR #190 round 1+2)
- Issue #179: `ScrollNotDelivered` (PR ~#193)
- Issue #180: `ClipboardWriteNotDelivered` (PR ~#194)
- Issue #181: `BrowserClickNotDelivered` / `BrowserFillNotDelivered` (PR ~#195)
- Issue #197: `ForegroundRestricted` / `BackgroundInputNotDelivered` (PR ~#205)
- Issue #207: `BackgroundKeyNotDelivered` (PR ~#210)
- Phase 5 I1 (PR #218): `FocusLostDuringType`
- ADR-011 Phase B B-1〜B-4 (PR #162/#164/#165/#168): `WorkingMemoryNUpperBoundExceeded` / `EpisodicMemoryNUpperBoundExceeded` / `SemanticMemoryKUpperBoundExceeded` / `ProceduralMemoryKUpperBoundExceeded`

合計 14 entries (Phase 5 closure 時点での post-ADR additions)。

### 2.3 misleading wording risk

Phase 6 PR-A Round 1+2 で line 279 + 281 + 334 + cascade ×6 docs に `(Phase 6 cleanup 後)` 注記を追加した結果、「**Phase 6 cleanup 後の現行 main = 22 codes**」と読める表現を強化してしまった。実際の current main は 36 codes (Phase 6 -3 後) であり、§5.4 catalog 22 codes は **ADR baseline + Phase 6 削除反映** であって live production state ではない。CLAUDE.md §3.1「主要表 / 見出しは注記より強く読まれる」教訓に該当する pattern。

---

## 3. 推奨対応 (別 PR で実施) — **Resolved (Phase 7 PR で実施済)**

### 3.1 §5.4 catalog 全面 reconcile **✓ Done**

Live `_errors.ts` SUGGESTS dictionary を grep して PascalCase code 全列挙し、§5.4 catalog の `// 引数・基本` / `// UIA / window` / `// Browser` / `// Terminal` / `// Wait / scroll` / `// RPG` / `// 入力チャネル` 各セクションに 14 entries を組み込む。新規セクション (例: `// Cognitive memory` for ADR-011 Phase B) も追加。

**反映**: ADR-010 §5.4 (line 277-341) を live SSOT bit-equal 同期、`// Cognitive memory (ADR-011 Phase B B-1〜B-4)` 新セクション追加で 4 codes 配置、`// Browser` / `// Wait / scroll` / `// 入力チャネル` 既存セクションに 10 codes 配置。

### 3.2 line 334 合計式更新 **✓ Done**

`合計 22 + 12 = **34 codes**` を `合計 36 + 12 = **48 codes** (Phase B B-1〜B-4 含む全 SSOT 反映後)` 等に再計算 (実数は 3.1 で確定後)。

**反映**: Live `_errors.ts` 確定値で `合計 37 + 12 = **49 codes**` に確定 (followups 記述の "36 + 12 = 48" は AutoGuardBlocked PR-B 加算前の見積、reconcile 時点では PR-B merge 後で 37 codes、+12 = 49)。

### 3.3 misleading wording 解消 **✓ Done**

line 279 「現行 main で classify ロジックも完備」を削除 or 「ADR 起草時 SSOT、その後 issue #178/#179/#180/#181/#197 + Phase B B-1〜B-4 で +14 codes 後追い保持中」に文言修正。

**反映**: line 277-279 narrative を全面 rewrite。「subset (23 codes)」前提を解消し、「live SSOT bit-equal で全反映 + ADR-added 12 codes = 49 codes」に書き換え。

### 3.4 cascade docs sync (catalog SSOT 本体 1 doc + cascade 8 docs = 計 9 docs 反映) **✓ Done**

3.1〜3.3 の reconcile 後、catalog SSOT 本体 (§5.4 を含む adr-010 main) と numeric ref を持つ cascade 8 docs を全数値更新:

**catalog SSOT 本体 (1 doc)**:
- `docs/adr-010-presentation-layer-self-documenting-envelope.md` line 59 (narrative typed reason 数) — **35 → 49** + §5.4 line 277-341 全面 rewrite (catalog 本体)

**cascade 8 docs (典 reason ref / 残 N codes ref)**:
- `docs/adr-007-p5a-design-proposal.md` line 213 (FailurePayload reason comment) — **35 → 49**
- `docs/adr-011-cognitive-memory-extension.md` line 81 (typed reason SSOT 参照) — **35 → 49**
- `docs/adr-011-phase-b-coala-plan.md` line 78 (同型 SSOT 参照) — **35 → 49**
- `docs/adr-010-p1-s3-plan.md` line 537 (expansion work 列挙) — **35 → 49**
- `docs/adr-010-p1-s4-plan.md` line 7 / 518 / 623 (概念設計参照 + Unknown 含む statement + 概念設計参照) — **35 → 49** + 残 36 → 48 (5 occurrences、line 38/65/76/282/503)
- `docs/adr-010-p1-s6-plan.md` 残 36 → 48 (6 occurrences、line 13/73/83/264/390/441 ASCII art)
- `docs/walking-skeleton-trunk-selection.md` 残 36 → 48 (3 occurrences、line 144 §3 trunk vs expansion 表 + line 366 §6.1 swimlane 並走戦略表 + line 383 §6.3 MAX 20x Sonnet 並走 todo)
- `docs/walking-skeleton-expansion-plan.md` 残 36 → 48 (2 occurrences、line 41 §2.1 swimlane 4 typed reason 表 + line 55 §2.2 swimlane 4 工数記述)

合計 sync: **catalog 49 - LeaseExpired 1 (S4 trunk 実装) = 残 48 expansion P2** が cascade 全 numeric ref に反映 (PR #231 Round 1 P2-1 反映で walking-skeleton-trunk-selection.md + walking-skeleton-expansion-plan.md の cascade sweep miss も解消)。

**Phase 7 F3 fix (本 doc Resolved 後の派生)**: F3 PR で SpawnFailed typed code が live `_errors.ts` に追加され、catalog 49 → **50 codes** / 残 48 → **49 codes** に更新。F3 PR 内で cascade 全 numeric ref を 1 commit で同期 sweep し、Phase 7 reconcile invariant を維持。

---

## 4. 優先度 (Resolved 後)

- **Medium** (P2 相当)。production behavior に影響なし、catalog の事実乖離のみ。LLM-perspective doc読者 (Codex / Claude / 本人) が「現行 main の typed code 数」を ADR catalog から推定する際に誤読する risk。
- **解決 timing**: Phase 7 carry-over fix #2 として実施 (F5 docs fix と同 Phase 7、F3/F4 production fix の前段)。Phase 6 PR-A/PR-B merge 後で AutoGuardBlocked 反映済の状態で reconcile、二重 update 回避。

---

## 5. 関連 SSOT

- `src/tools/_errors.ts` (live SUGGESTS dictionary、SSOT)
- `docs/adr-010-presentation-layer-self-documenting-envelope.md` §5.4 (catalog、本 follow-up の対象)
- `tests/unit/issue-211-classify-branch-producer-pin.test.ts` (classify branches CI sweep、Phase 6 PR-A で 29 branches 同期済)
