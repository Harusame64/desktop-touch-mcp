# ADR-010 Follow-ups (post-Phase-6 cleanup)

- Status: **Active** (起票 2026-05-09、Phase 6 PR-A `feature/phase6-dead-code-cleanup` Round 3 Opus review で発見)
- 親 ADR: `docs/adr-010-presentation-layer-self-documenting-envelope.md`
- 起票元 PR: #227 (Phase 6 PR-A 6-1/6-2/6-3 dead code dictionary cleanup)

## 1. 趣旨

Phase 6 PR-A の Round 3 Opus review で **ADR-010 §5.4 catalog と現行 `src/tools/_errors.ts` SUGGESTS dictionary の事実乖離** が発見された。memory に書くと揮発する (強制命令 9) ため本 docs に永続記録、別 PR で reconcile する。

---

## 2. ADR-010 §5.4 catalog と live `_errors.ts` の数値乖離

### 2.1 事実

- **ADR-010 §5.4 catalog 主張**: 「既存 22 codes」 (Phase 6 cleanup 後、line 279 / 281、Phase 6 削除 3 件反映済)
- **現行 main HEAD `925ce8b` 時点 `_errors.ts` SUGGESTS**: 39 entries
- **Phase 6 PR-A `af8479a` 時点**: 36 entries (-3 で Phase 6 削除完了)
- **乖離**: 14 entries が ADR-010 §5.4 catalog に未反映 (`_errors.ts` だけ後追いで追加され、ADR catalog 全面 reconcile が怠られた累積)

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

## 3. 推奨対応 (別 PR で実施)

### 3.1 §5.4 catalog 全面 reconcile

Live `_errors.ts` SUGGESTS dictionary を grep して PascalCase code 全列挙し、§5.4 catalog の `// 引数・基本` / `// UIA / window` / `// Browser` / `// Terminal` / `// Wait / scroll` / `// RPG` / `// 入力チャネル` 各セクションに 14 entries を組み込む。新規セクション (例: `// Cognitive memory` for ADR-011 Phase B) も追加。

### 3.2 line 334 合計式更新

`合計 22 + 12 = **34 codes**` を `合計 36 + 12 = **48 codes** (Phase B B-1〜B-4 含む全 SSOT 反映後)` 等に再計算 (実数は 3.1 で確定後)。

### 3.3 misleading wording 解消

line 279 「現行 main で classify ロジックも完備」を削除 or 「ADR 起草時 SSOT、その後 issue #178/#179/#180/#181/#197 + Phase B B-1〜B-4 で +14 codes 後追い保持中」に文言修正。

### 3.4 cascade docs (本 PR-A で `(Phase 6 cleanup 後)` 注記済 8 docs) の sync

3.1〜3.3 の reconcile 後、本 PR-A で `(Phase 6 cleanup 後)` 注記を追加した以下 8 docs を全数値更新:
- `docs/adr-010-presentation-layer-self-documenting-envelope.md` line 59 (typed reason 数)
- `docs/adr-007-p5a-design-proposal.md` line 213 (FailurePayload reason comment)
- `docs/adr-011-cognitive-memory-extension.md` line 81 (typed reason SSOT 参照)
- `docs/adr-011-phase-b-coala-plan.md` line 78 (同型 SSOT 参照)
- `docs/adr-010-p1-s3-plan.md` line 537 (expansion work 列挙)
- `docs/adr-010-p1-s4-plan.md` line 7 / 518 / 623 (概念設計参照 + Unknown 含む statement + 概念設計参照)

---

## 4. 優先度

- **Medium** (P2 相当)。production behavior に影響なし、catalog の事実乖離のみ。LLM-perspective doc読者 (Codex / Claude / 本人) が「現行 main の typed code 数」を ADR catalog から推定する際に誤読する risk。
- **着手 timing**: Phase 6 PR-A merge 後、PR-B (AutoGuardBlocked classify branch 6-4) と並走するか別 session で。Phase 6 PR-B が classify branch を 1 本追加するため、reconcile タイミングは PR-B merge 後が望ましい (二重 update 回避)。

---

## 5. 関連 SSOT

- `src/tools/_errors.ts` (live SUGGESTS dictionary、SSOT)
- `docs/adr-010-presentation-layer-self-documenting-envelope.md` §5.4 (catalog、本 follow-up の対象)
- `tests/unit/issue-211-classify-branch-producer-pin.test.ts` (classify branches CI sweep、Phase 6 PR-A で 29 branches 同期済)
