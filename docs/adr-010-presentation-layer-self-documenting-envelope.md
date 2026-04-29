# ADR-010: LLM-Facing Presentation Layer — Self-Documenting View Envelope

- Status: **Proposed (Draft for review)**
- Date: 2026-04-29
- Authors: Claude (Opus, max effort) — project `desktop-touch-mcp`
- Related:
  - ADR-007: koffi → Rust 全面移行 (Layer 1 = センサー層)
  - ADR-008: Reactive Perception Engine via Differential Dataflow (Layer 2-3 = データ層)
  - ADR-009: HW Acceleration Plane (Tier 別実装ガイド、後続)
  - 後続: ADR-011: Cognitive Memory Taxonomy 拡張 (Semantic / Procedural memory)
- 北極星: LLM の不安を消す + 復帰経路を typed に提供 + Tool 数を増やさず 1 tool の表現力を上げる

---

## 1. Context

### 1.1 LLM の不安行動

現状の MCP server を使った LLM の観察可能な「不安行動」:

- 同じ `desktop_state` を短時間に 3 回連続で呼ぶ
- screenshot を保守的に多めに撮る
- 大胆な操作を避け、小刻みな step に分割しすぎる
- エラー時に root cause に至れず、似た tool を試行錯誤する
- 過去の自分の認識が正しかったか確認できないまま進む

これらは **「Tool が情報を返してくれない」** のではなく、**「Tool が信じる根拠を返してくれない」** が原因。

### 1.2 不安源の分解

LLM の不安は 7 つに分解できる。

| 不安源 (人間語) | 不安源 (技術語) | 必要データ |
|---|---|---|
| 「今見えてるの本物？」 | state freshness 不明 | as_of timestamp + freshness_ms + confidence |
| 「自分の click 効いた？」 | 副作用の不可視性 | caused_by (直前行動 → 観測差分) |
| 「なぜ失敗した？」 | failure mode 不透明 | typed reason + most_likely_cause |
| 「次どうしよう…」 | 復帰経路なし | try_next (typed action list with confidence) |
| 「結果が矛盾してない？」 | 観測整合性不明 | invariants_held |
| 「2 つ前の自分は正しかった？」 | 過去への信頼欠如 | query_past (time-travel link) |
| 「やったら何起きる？」 | 副作用予見不能 | if_you_did (dry-run preview) |

### 1.3 物理基盤側 (ADR-007/008 で構築済 / 構築予定)

- ADR-007 = L1 Capture: 全 event は `event_id` + `(wallclock_ms, sub_ordinal)` で tagged ring buffer に
- ADR-008 = L2 Storage + L3 Compute: arrangement = MVCC store、`state_at(t)` 可、`predicted_post_state` view あり
- 本 ADR-010 = L4 Projection + L5 Tool Surface: 上記 view を **LLM が信じられる形** で整形して返す

### 1.4 SSOT 参照

本 ADR の不変条件・SLO・境界は **統合書** (`docs/architecture-3layer-integrated.md` §4-§5、§17) と **`docs/layer-constraints.md` §5-§6** (L4 Projection / L5 Tool Surface) を SSOT とする。`most_likely_cause` typed enum は **`src/tools/_errors.ts` の SUGGESTS が SSOT** (§5.4 参照)。本 ADR で記述された規約と SSOT の間に齟齬が生じた場合、SSOT を優先し、本 ADR は後追い更新する (統合書 §16.1)。

主な参照対応:
- 識別子ヒエラルキー (session_id / tool_call_id / event_id / lease_token) → 統合書 §4
- 時刻モデル (envelope.as_of は wallclock_ms canonical) → 統合書 §5
- lease_token は単一 ID ではなく 4-tuple (`entityId` / `viewId` / `targetGeneration` / `evidenceDigest`)、envelope 内で展開 → 統合書 §4 / `LeaseStore` 既存実装
- L4 envelope assembly 制約 (p99 < 5ms 等) → layer-constraints §5
- L5 tool surface 制約 (query/commit/subscribe SLO) → layer-constraints §6
- typed reason 35 codes (PascalCase) → §5.4

---

## 2. Decision

### 2.1 主要決定 (8 項目)

| # | 項目 | 決定 |
|---|---|---|
| 1 | 共通 envelope 採用 | 全 tool 結果が **Self-Documenting View Envelope** で返却 (§5) |
| 2 | 必須 vs 任意フィールド | **必須最小** (`data`, `as_of`, `confidence`) **+ 任意拡張** (`include` 引数で取捨) |
| 3 | 4 設計原則 | Provenance over Promise / Causal Continuity / Recovery as First-Class / Time as Affordance (§4) |
| 4 | Time-travel リンク | **全 tool に `query_past` リンクのみ提供** (overhead 小)、実呼び出しは LLM の判断 |
| 5 | Dry-run | **副作用が大きい tool に opt-in** (`dry_run=true` で preview のみ返却)。対象: click / fill / keyboard / browser_* / mouse_drag / scroll(action='click') |
| 6 | CoALA memory 採用度 | **段階的**。Phase A = Working + Episodic、Phase B = Semantic + Procedural は ADR-011 で切り出し |
| 7 | 失敗時 envelope | **失敗も envelope 形式で返す**。`data: null` + `if_unexpected` を必ず埋める |
| 8 | schema versioning | envelope に `_version` フィールド。後方互換は MAJOR 上げ時のみ破る |

### 2.2 設計の核

LLM 不安源 7 つに envelope の 7 セクションが 1:1 対応する。**LLM は 1 つの shape を覚えるだけ** で全 tool が読める。各セクションは L3 view からの projection で、実装上は薄い wrapper。

---

## 3. Architecture

### 3.1 5 層との位置づけ

```
┌─────────────────────────────────────────────────────────┐
│ L5: MCP Tool Surface             ← 本 ADR-010 ★        │
│     既存 tool の応答を Envelope で wrap                 │
├─────────────────────────────────────────────────────────┤
│ L4: Cognitive Projection         ← 本 ADR-010 (一部) ★ │
│     Working + Episodic を view として提供               │
│     Semantic / Procedural は ADR-011                   │
├─────────────────────────────────────────────────────────┤
│ L3: Compute (IVM)                ← ADR-008             │
│     view 提供元: current_state / dirty_rect_aggregate / │
│     semantic_event / predicted_post_state               │
├─────────────────────────────────────────────────────────┤
│ L2: Storage (MVCC)               ← ADR-008             │
├─────────────────────────────────────────────────────────┤
│ L1: Capture (event ring buffer)  ← ADR-007             │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Envelope の組立て (実装視点)

```
tool 呼び出し
    │
    ▼
[Layer 5 wrapper] ─ envelope skeleton 作成
    │
    ├─ data         ← 旧 tool 実装の戻り値
    ├─ as_of        ← L3 の最新 frontier
    ├─ confidence   ← L3 view の freshness 判定
    ├─ caused_by    ← L4 episodic memory の最近 1 件 + L3 diff view
    ├─ invariants   ← L3 で監視中の invariant view
    ├─ if_unexpected ← 失敗時のみ、typed reason map から検索
    ├─ query_past   ← static link (実呼び出し時のみ L2 起動)
    └─ if_you_did   ← (dry_run=true 時のみ) L3 predicted_post_state
    │
    ▼
client (LLM) へ返却
```

各セクション組立てのコストは **すべて L3 の既存 view 参照** で、追加計算なし。

---

## 4. Four Design Principles

### 4.1 Provenance over Promise

結果には必ず「出自」と「freshness」を付ける。約束しない、根拠を示す。

- ❌ "focused element is X"
- ✓ "based on UIA event #87 at wallclock_ms=1738156823412 (47ms ago), focused element is X, confidence=fresh"

### 4.2 Causal Continuity

tool 呼び出しは isolated event ではなく、**直前の自分の行動の結果** として提示する。

- ❌ "current state: { focused: B }"
- ✓ "after your click(120,240) 87ms ago, focus changed: A → B"

### 4.3 Recovery as First-Class

失敗時、文字列 throw ではなく **typed recovery hint** を返す。

- ❌ `Error("modal blocking")`
- ✓ `if_unexpected: { most_likely_cause: "modal_blocking", try_next: [{action: "click_element", args: {name: "OK"}, confidence: "high"}] }`

### 4.4 Time as Affordance

過去への入口を必ず開けておく。LLM が不安なら戻れる。

- ✓ 全 tool 結果に `query_past.state_2s_ago: "call: state_at(now-2s)"` を付ける
- 実呼び出しコストは LLM が払う、リンクだけなら無料

---

## 5. Self-Documenting View Envelope (Schema)

```jsonc
{
  "_version": "1.0",                          // schema version

  // ── 主データ ──
  "data": { /* tool 固有 */ },                 // 失敗時 null

  // ── Self-Attestation ──
  "as_of": {
    "wallclock_ms": 1738156823412,            // 統一 wallclock
    "logical": [42, 7]                        // L3 logical time (epoch, sub_ordinal)
  },
  "freshness_ms": 47,                          // 観測されてからの経過
  "based_on": {
    "events": [42, 87],                        // L1 event_id range
    "sources": ["UIA", "DXGI", "Reflex"]
  },
  "confidence": "fresh",                       // fresh | cached | inferred | stale

  // ── Causal Trail (任意、include に応じて) ──
  "caused_by": {
    "your_last_action": "click(x=120, y=240)",
    "session_id": "abc-123",
    "elapsed_ms": 87,
    "produced_changes": ["focus: A→B", "modal: closed"]
  },

  // ── Invariants Surfaced (任意) ──
  "invariants_held": [
    "window_title_stable_since:event_42",
    "no_concurrent_focus_change",
    "lease_digest_matched"
  ],

  // ── Recovery Hints (失敗時必須) ──
  "if_unexpected": {
    "most_likely_cause": "modal_blocking",     // typed enum
    "blocker": { "name": "確認ダイアログ", "kind": "Dialog" },
    "try_next": [
      { "action": "click_element", "args": { "name": "OK" }, "confidence": "high" },
      { "action": "keyboard", "args": { "key": "Escape" }, "confidence": "medium" }
    ],
    "escalation": "if_above_fail: capture screenshot and report"
  },

  // ── Time-Travel Link (常に提供、リンクのみ) ──
  "query_past": {
    "state_2s_ago": "call: state_at(now-2s)",
    "diff_since_last_call": "call: diff(your_last_call_id, now)",
    "replay_session": "call: replay(session_id, from=event_42, to=event_87)"
  },

  // ── What-If Preview (dry_run=true 時のみ) ──
  "if_you_did": {
    "click(button='次へ')": {
      "predicted_focus": "input_age",
      "predicted_modal": null,
      "predicted_dirty_rect": [120, 240, 80, 30],
      "confidence": "high"
    }
  }
}
```

### 5.1 必須最小 (default)

```
{ _version, data, as_of, confidence }
```

### 5.2 任意拡張 (`include` で要求)

| include 値 | 追加されるフィールド | 想定用途 |
|---|---|---|
| `causal` | `caused_by` | 自分の行動と結果の因果が知りたい |
| `invariants` | `invariants_held` | 整合性を検証したい |
| `time_travel` | `query_past` | 過去への戻り口が欲しい (default で常時) |
| `working:N` | `caused_by.recent_window` (直近 N event compact) | working memory が欲しい |
| `episodic:N` | `caused_by.tool_call_history` (直近 N tool 呼び出し) | 自分の行動履歴が欲しい |

### 5.3 失敗時 envelope

```jsonc
{
  "_version": "1.0",
  "data": null,
  "as_of": { ... },
  "confidence": "stale",                       // 失敗時は stale 固定
  "if_unexpected": {                           // 必須
    "most_likely_cause": "lease_expired",
    "try_next": [{ "action": "desktop_discover", ... }]
  },
  "query_past": { ... }                        // 過去への戻り口は失敗時こそ重要
}
```

### 5.4 typed enum 一覧 — 既存 `_errors.ts` SUGGESTS を SSOT として吸収

既存 `src/tools/_errors.ts` の `SUGGESTS` には **25 個の PascalCase code** が運用済 (現行 main で classify ロジックも完備)。本 ADR の `most_likely_cause` は **これを SSOT として吸収** し、新規追加分のみ拡張する。

#### 既存 25 codes (現行 main、PascalCase 維持)

```
// 引数・基本
InvalidArgs

// UIA / window
WindowNotFound | ElementNotFound | InvokePatternNotSupported |
ElementDisabled | UiaTimeout | BlockedKeyCombo

// Browser
BrowserNotConnected | BrowserSearchNoResults | BrowserSearchTimeout |
ScopeNotFound

// Terminal
TerminalWindowNotFound | TerminalTextPatternUnavailable | TerminalMarkerStale

// Wait / scroll
WaitTimeout | ScrollbarUnavailable | OverflowHiddenAncestor |
VirtualScrollExhausted | MaxDepthExceeded

// RPG
GuardFailed | LensNotFound | LensBudgetExceeded

// 入力チャネル
BackgroundInputUnsupported | BackgroundInputIncomplete |
SetValueAllChannelsFailed
```

#### 本 ADR で追加する codes (PascalCase 統一)

```
// RPG lease (lease-store の validate 結果と 1:1 対応)
LeaseExpired | LeaseGenerationMismatch | LeaseDigestMismatch |
EntityNotFound | EntityOutsideViewport

// 状態遷移
ModalBlocking | Settling

// HW Tier
HwTierUnavailable

// その他
AccessDenied | Unknown
```

合計 25 + 10 = **35 codes**。

#### 運用ルール

1. **SSOT は `src/tools/_errors.ts`** の `SUGGESTS` map。`try_next` は SUGGESTS の各値を **typed action 化** したものに移行 (P2 で実装)
2. 既存 SUGGESTS の **`suggest: string[]`** を envelope の **`try_next: TypedAction[]`** に進化させる際、最初は string をそのまま `try_next[].action_hint` に格納し、徐々に `{action, args, confidence}` に typed 化
3. lease 関連 5 codes は `LeaseStore.validate()` の `reason` (`expired` / `generation_mismatch` / `entity_not_found` / `digest_mismatch`) を PascalCase に変換した値と 1:1
4. `Unknown` は coverage 改善の対象 — 発生時に必ず log し、SSOT に追記する運用

#### LLM への露出

`most_likely_cause: "WindowNotFound"` のように PascalCase そのまま。snake_case 変換は行わない (既存 client compat と TS型側との一貫性のため)。

---

## 6. CoALA Memory Mapping (Phase A)

| memory type | 本 ADR で対応 | 提供 view | 取得方法 |
|---|---|---|---|
| Working | ✓ Phase A | `current_state` (recent N event compact) | `include=working:N` |
| Episodic | ✓ Phase A | `tool_call_history` (自分の過去の呼び出し + outcome) | `include=episodic:N` |
| Semantic | ✗ Phase B (ADR-011) | `learned_ui_pattern` (page graph 風) | 将来 |
| Procedural | ✗ Phase B (ADR-011) | `successful_macros` (fused action) | 将来 |

LLM は include 引数で **「今欲しい memory layer」を select** できる:

```
desktop_state(include=["working:10", "episodic:5", "causal", "invariants"])
```

→ context window の経済的使用 + LLM が **自分の認知負荷を自分で管理**。

---

## 7. Implementation Phases

| Phase | 範囲 | 完了基準 |
|---|---|---|
| **P1: Envelope 必須最小** | `_version`, `data`, `as_of`, `confidence` を全 tool に注入する wrapper 作成 | 既存 tool 全部の応答が envelope 経由、回帰なし |
| **P2: typed reason 整備** | `most_likely_cause` enum + `try_next` テンプレ map | 既存 tool の error が typed reason に 100% mapping |
| **P3: include 拡張 (causal / invariants)** | `caused_by` (last action linkage) と `invariants_held` を view から projection | include で取捨可能、ベンチで latency overhead < 5ms |
| **P4: time-travel link 注入** | `query_past` を全 tool 応答に static link として常時付与 | リンク存在のみ、実呼び出しは ADR-008 D3 完了待ち |
| **P5: dry-run** | 副作用大の tool に `dry_run=true` 引数追加、`if_you_did` を返す | 5 tool 以上で動作、predicted vs actual 一致率測定 |
| **P6: working / episodic** | `include=working:N` / `episodic:N` 実装 | LLM context 削減効果を A/B で測定 |
| **P7: schema versioning + migration tooling** | `_version` 進化のためのテストハーネス | MAJOR 上げ手順書、後方互換テスト pass |

---

## 8. Alternatives Considered

### 8.1 別 schema (失敗時とは別 envelope)

成功 / 失敗で別 schema にすると LLM が分岐コードを書く必要がある。**統一 envelope** にすると分岐不要、`data === null` または `if_unexpected !== null` で判定。

→ 不採用。

### 8.2 Envelope 全フィールド常時返却

LLM の context 消費が膨らむ。include 任意拡張で **LLM 自身が経済性を判断** できる方が良い。

→ 不採用。

### 8.3 Time-travel を一部 tool 限定

「過去への戻り口」は失敗時こそ最重要。**全 tool に link 提供** する方が安全網として強い。リンクだけならコスト極小。

→ 採用 (全 tool)。

### 8.4 typed reason ではなく自由文字列

LLM は自由文字列を読める (LLM だから当然)。だが、**try_next の typed action list** が文字列だと parsing 失敗の可能性。typed の方が信頼性高い。

→ typed reason + typed try_next を採用。

---

## 9. Risks

| # | リスク | 影響 | 軽減策 |
|---|---|---|---|
| 1 | Envelope のオーバーヘッドで応答 size 増 | Medium | 必須最小 default + include で経済性、サイズベンチで監視 |
| 2 | typed enum の網羅漏れで `unknown` 多発 | Medium | error 発生時に毎回 most_likely_cause を log → coverage を増やす運用 |
| 3 | predicted_post_state の精度が低い | High | dry-run 結果に必ず confidence を添付、low confidence は LLM が無視可 |
| 4 | session_id の管理 owner 不明 | High | MCP request id を session_id にマッピング (実装時に確定) |
| 5 | schema 進化で後方互換が壊れる | Medium | `_version` を MAJOR.MINOR で管理、MAJOR 上げ時のみ破壊 |
| 6 | LLM が include を全部付ける (経済性無視) | Low | デフォルトで最小、追加は明示的、サイズ警告を docs に明記 |
| 7 | dry-run と実 action の挙動乖離 | High | dry-run 後の実行で diff 計測、乖離率を engine 内で監視 |

---

## 10. Acceptance Criteria

| Phase | 完了基準 |
|---|---|
| P1 | 全 tool が envelope 形式で応答、既存 LLM session で回帰 0 |
| P2 | typed reason の coverage > 95%、`unknown` 発生時の log で残り 5% を埋める |
| P3 | `include=causal,invariants` で envelope size 1.5x 以内、latency overhead < 5ms |
| P4 | `query_past` link が全 tool に常時、実呼び出しで ADR-008 D3 と接続成功 |
| P5 | 主要 5 tool で dry_run=true 動作、predicted vs actual 一致率 > 80% |
| P6 | `include=working:N` / `episodic:N` で LLM context 1/3 削減 (代表シナリオ) |
| P7 | `_version: 2.0` への migration を test harness で全 tool シミュレート |

---

## 11. Open Questions

| # | 質問 | 検討タイミング |
|---|---|---|
| 1 | session_id を MCP request id と紐付けるか、独自管理か | P1 着手前 |
| 2 | `query_past` リンクの URI 形式 (string call: vs structured ref) | P4 着手時 |
| 3 | dry-run の 100% 精度はムリ、許容ライン (50% / 80% / 95%) | P5 着手時に決定 |
| 4 | include の値を文字列か enum か (typed の方が安全) | P3 着手前 |
| 5 | error envelope の `_errors.ts` 既存 SUGGESTS との合流 | P2 着手時 |
| 6 | working memory の N 上限 (推奨 default は何か) | P6 のベンチ後 |
| 7 | Subscribe API (push) が来たら envelope はどう扱う | ADR-008 D2 と擦合せ |

---

## 12. 公開価値

「LLM が不安にならない MCP server」 — UX 観点での新ニッチ。

- 競合 MCP server は raw 結果を返すだけ。本 ADR の envelope は **LLM ergonomics に踏み込んだ初の試み**
- 4 設計原則 (Provenance / Causality / Recovery / Time) は他の MCP server にも転用可、論文 / ブログ / talk のネタになる
- ADR-008 の MVCC + IVM がこの envelope を実装上 **ほぼ無料** (各セクションが view からの projection) にする

---

## 13. Related Artifacts (起草前 / 起草予定)

- 本 ADR (`docs/adr-010-presentation-layer-self-documenting-envelope.md`)
- 前段: `docs/adr-007-koffi-to-rust-migration.md` (起草中、L1)
- 前段: `docs/adr-008-reactive-perception-engine.md` (起草済、L2-3)
- 後続: `docs/adr-009-hw-acceleration-plane.md` (Tier 別実装ガイド)
- 後続: `docs/adr-011-cognitive-memory-extension.md` (Semantic / Procedural memory、Phase B)
- 統合: `docs/architecture-3layer-integrated.md` (3 層俯瞰、ADR-007/008/010 を 1 ドキュメントに編む、本 ADR 完了後に起草予定)

---

END OF ADR-010 (Draft).
