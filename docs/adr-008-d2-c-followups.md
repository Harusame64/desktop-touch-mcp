# ADR-008 D2-C — post-merge follow-ups

PR #108 (S2 walking skeleton trunk impl、merged 2026-05-01 `7986838`) の
**post-merge follow-ups** を集約する永続 docs (CLAUDE.md 強制命令 9: 残件は
memory ではなく docs/)。

Round 1 (Opus + Codex)、Round 2 (Opus re-review)、User review、Round 4
post-merge correction PR で順次反映。完了した item は strikethrough +
**Resolved** 化、carry-over 対象は OQ として永続化。

## 1. Resolved (post-merge correction PRs)

### 1.1 ~~Round 2 P2-A: late-older arrival post-eviction retraction panic~~

**Resolved** in Round 4 PR (post-merge): `dirty_rects_aggregate.rs::apply_count`
で `prior == 0 && diff < 0` の場合に silently drop、`debug_assert!` を
回避。`apply_count_late_older_arrival_followed_by_retraction_does_not_panic`
test で regression pin。

### 1.2 ~~Round 2 P2-B: `processedCount` focus-only docs sync~~

**Resolved** in Round 4 PR: `index.d.ts` + `src/engine/native-types.ts` の
`NativeViewFocusedPipelineStatus.processedCount` JSDoc に
「**Focus-only since S2 D2-C** (Codex round 1 P2-B): dirty-rect traffic
uses separate counter」を明記。Caller の誤解 (focus-pipeline activity vs
all-event count) を防ぐ。

### 1.3 ~~Round 2 P3-B: G2-3 test `wc_base + 5_000` pump rationale~~

**Resolved** in Round 4 PR: `crates/engine-perception/src/input.rs` の G2-3
test pump event に「Why +5_000ms specifically」コメント拡張。
WATERMARK_SHIFT_MS=100 + DD 5-tuple operator graph settle latency +
batched-vs-trickled push pattern + flake margin の根拠を明記。

### 1.4 ~~Round 1 → Round 2 → Round 3 (User review) findings 全反映~~

PR #108 head merged shape: Round 1 + Round 2 + Round 3 (User P2 type
contract) で計 11 findings (Opus P1×2 + P2×4 + P3×3 + Codex P2×2 +
User P2×1) を 3 round で 1 PR に集約 land。`docs/adr-008-d2-c-plan.md`
§2.3 + sub-plan 全段で bit-equal sync。

## 2. Open Questions (carry-over to expansion / S6)

### 2.1 OQ #4 (Round 2 P3-A): test helper unification

`crates/engine-perception/src/input.rs::tests` の **2 つの make_event helper**:

- `make_event(source_event_id, wallclock_ms, sub_ordinal)`: pre-S2、`hwnd: 0x1234`
  ハードコード (per-hwnd diversity 不要なテスト用、17 箇所で使用)
- `make_focus_event_with_hwnd(hwnd, wallclock_ms, sub_ordinal)`: S2 G2-3
  追加、per-hwnd 多様性必要なテスト用

両者の存在は **API 重複** で、将来 test 増えたときに「どちらを使うか」判断が
分散する。統一案:

- **(a)** `make_event` の第 1 引数を `hwnd` に変更 (rename `source_event_id`
  → `hwnd`、source_event_id は新たに自動採番) → 既存 17 callers の意味的
  再解釈が必要 (source_event_id 値は意味的には任意なので影響軽微)
- **(b)** `make_event` を `make_focus_event_with_hwnd(0x1234, ...)` に
  delegating fn 化 → backward compat 維持しつつ helper 1 本に collapse
- **(c)** carry-over (現状維持)、test 増加で再評価

**推奨**: (b) — backward compat + DRY、Round 4 と分離して別 PR で吸収可能。
**着手 timing**: walking skeleton trunk 完了 (S6) 後の expansion phase 初期、
あるいは S3 (envelope wrapper) impl で focus event 多様性 test が追加で
必要になったタイミング (どちらが先でも OK)。

### 2.2 OQ #5 (Round 2 P3-C): 3-leg shutdown helper macro / OQ

`PerceptionPipeline::shutdown_with_timeout` の 3-leg concurrent polling
shape は将来 5/6 leg (例: window_pump、scroll_pump 追加時) で scale すると
boilerplate 増加。

- **(a)** macro_rules!化 (`shutdown_legs!(self, timeout, [pump, dirty_pump,
  worker])`) で leg list を引数にして展開
- **(b)** trait `Shutdownable { fn signal_shutdown(&self); fn join_with_timeout(&self, Duration) -> Result<(), &'static str>; }`
  + slice ベース concurrent polling generic helper
- **(c)** 現状の 3-leg ハードコード維持 (新 leg 追加時に 1 行 edit で対応)

**推奨**: (b) — 拡張性 + テスタビリティ、ただし pump trait 化は L3 bridge
内側 abstraction 増加で慎重判断必要。**着手 timing**: 4 leg 目を追加する
PR (P5c-3 window_pump or P5c-4 scroll_pump) と同時、別 PR で先行リファクタ
する判断は不要。

### 2.3 OQ #6 (Round 2 P2-2 carry-over): `last_event_anchor` cmd_kind trace

worker_loop の `last_event_anchor: Option<(u64, Instant)>` 共有変数が
focus と dirty rect 両方で更新される。trace 観点では「どの cmd 経由で
更新されたか」が log に出ないため、production debug 時に分析しにくい。

- **(a)** `eprintln!` の anchor update site に `cmd_kind: "focus" | "dirty_rect"`
  field 追加 (運用観点 trace 拡張、code shape 不変)
- **(b)** `last_event_anchor` を `(u64, Instant, AnchorSource)` 3-tuple
  に拡張、production telemetry に source も expose
- **(c)** 現状維持 (両 cmd の wallclock_ms は monotone と契約)

**推奨**: (a) — production debug 体験向上、impl side effect なし。**着手
timing**: 別 PR、optional。

### 2.4 OQ #7 (Round 2 P3-A from R1): `decode_dirty_rect_event` arc shape

`src/l3_bridge/dirty_rect_pump.rs::decode_dirty_rect_event` の引数は
`&AtomicU64` direct ref、`focus_pump.rs::decode_focus_event` は
`&AtomicU64` (after_none_skip + decode_failures 2 atomics) で挙動同等
だが arg shape 微差。mechanical コピー徹底観点で focus_pump 同型化推奨
(carry-over)。

## 3. 4 Round summary (本 PR まとめ)

| Round | Reviewer | Findings | Apply commit |
|---|---|---|---|
| 1 | Opus phase-boundary | P1×2 + P2×4 + P3×3 (Conditionally Approved) | a6d30a0 |
| 1 | Codex auto | P2×2 | a6d30a0 |
| 2 | Opus re-review | P1 ゼロ + P2×2 + P3×2 (Conditionally Approved) | post-merge follow-up PR |
| 3 | User | P2×1 (latest field type/runtime mismatch) | 9a1fe5e |

User merged after Round 3 (head `9a1fe5e` → squash-merged as `7986838`)。
Round 2 Opus P2-A/P2-B + P3-A/P3-B + P3-C は本 follow-up doc + Round 4 PR
で吸収。

## 4. Lessons captured (memory candidate)

- **TypeScript type 契約と runtime behavior の mismatch** (PR #108 User P2):
  napi-rs `Option::None` for nested struct field is **omitted** (key
  absent), not `null`. Pre-existing patterns (`NativeFocusedElement.automationId`
  with `string | null`) may have the same gap. Surface via runtime smoke
  tests with `'field' in result` assertion.

- **Late-older arrival cap eviction race** (PR #108 Opus Round 2 P2-A):
  diff bookkeeping pattern (`current_focused_element` template) doesn't
  natively handle cap eviction wiping `by_key` entries underneath
  ongoing DD reduce retraction streams. Soft-clamp negative diff sums
  with prior == 0 to drop silent. Add test for assert + evict + retract
  triplet to guard against regression.

- **Counter contamination across cmd types** (PR #108 Codex P2-B):
  shared `processed_count` across `Cmd::PushFocus` and `Cmd::PushDirtyRect`
  contaminates focus-pipeline telemetry. Per-cmd counters + dedicated
  napi-exposed status struct prevents masking of focus health regressions.
  Apply same pattern to future cmd variants (Window / Scroll / etc.) at
  introduction time.
