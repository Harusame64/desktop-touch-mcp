# Anti-Fukuwarai v2 — Batch H2 Negative Capability Surfacing 実装計画

作成: 2026-04-24
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`
対象 instructions: [anti-fukuwarai-v2-h2-negative-capability-instructions.md](./anti-fukuwarai-v2-h2-negative-capability-instructions.md)

本計画の目的は、H2 バッチを「最小変更で最大の説明可能性向上」を得る構成に落とし込むことである。コードは本計画段階では一切変更しない。

---

## 0. 現状把握サマリ

### 0.1. `DesktopSeeOutput` 現状 (src/tools/desktop.ts:38-44)

```ts
export interface DesktopSeeOutput {
  viewId: string;
  target: { title: string; generation: string };
  entities: EntityView[];
  warnings?: string[];   // 平文の warning code 配列
}
```

### 0.2. 実際に出現する warning code (一次情報)

| 出所 | code | 意味 |
|---|---|---|
| compose-providers.ts / _resolve-window.ts | `no_provider_matched` | foreground 取得失敗 |
| compose-providers.ts | `partial_results_only` | primary 0 件で additive のみ |
| compose-providers.ts (H4) | `visual_not_attempted` | UIA blind + visual unready |
| compose-providers.ts (H4) | `visual_attempted_empty` | UIA blind + visual warm + 0 件 |
| compose-providers.ts (H4) | `visual_attempted_empty_cdp_fallback` | CDP 失敗 + visual 0 件 |
| uia-provider.ts (H4) | `uia_blind_single_pane` | single giant pane |
| uia-provider.ts (H4) | `uia_blind_too_few_elements` | 要素数が閾値未満 |
| compose-providers.ts | `uia_provider_failed` | UIA 呼び出し reject |
| compose-providers.ts | `cdp_provider_failed` | CDP 呼び出し reject |
| compose-providers.ts | `terminal_provider_failed` | terminal 呼び出し reject |
| terminal-provider.ts | `terminal_buffer_empty` | TextPattern バッファ空 |
| candidate-ingress.ts | `ingress_fetch_error` | ingress fetch throw |
| compose-providers.ts (retry 対象) | `visual_provider_unavailable` / `visual_provider_warming` | visual backend 未準備 |
| _resolve-window.ts (H3) | `dialog_resolved_via_owner_chain` | dialog owner chain 経由解決 |
| _resolve-window.ts (H3) | `parent_disabled_prefer_popup` | modal popup 切替 |

### 0.3. terminal type の実態 (src/tools/desktop-executor.ts:34-42, 244)

instructions 本文にある「terminal provider は read のみ、type executor 未対応」は **半分正しく、半分古い**。G2 バッチで terminal type は WM_CHAR background send で実装済みで、unsupported window (Chromium / UWP terminal) のときだけ `executor_failed` を返す設計になっている (`bg-input.ts` + `terminalBgExecute`)。したがって

- `actionability: ["type"]` を無条件で `["read"]` に変えるのは回帰
- 「window が supported かどうか」が pre-emptive に分かる方が重要

という判断になる。

---

## 1. 質問への回答

### Q1. `ViewConstraints` の設計（案 A）は適切か

**結論: 採用する。ただし形式・命名を次のように修正する。**

#### 1-1. 命名と型

案 A の `"blind" | "unavailable" | "not_attempted" | "attempted_empty" | "read_only"` のような provider ごとの列挙は、H4 で既に導入した warning code と 1:1 対応しやすい。ただし以下を守ること。

- **フィールド名は既存 warning code から機械的に derive できる語を使う**（新語を作らない）
- **LLM が `undefined` / missing 時に「制約なし」と解釈できる optional shape**
- **additive**（既存 `warnings[]` は残す）

草案:

```ts
/**
 * View-level negative capability hints.
 * Derived deterministically from ProviderResult.warnings.
 * Absent field = no constraint known (not "capability present").
 */
export interface ViewConstraints {
  /** UIA lane unable to surface meaningful entities for this target. */
  uia?: "blind_single_pane" | "blind_too_few_elements" | "provider_failed";
  /** CDP lane unavailable or failed for this target (browser targets only). */
  cdp?: "provider_failed";
  /** Visual lane status when structured lane was blind / failed. */
  visual?: "not_attempted" | "attempted_empty" | "provider_unavailable" | "provider_warming";
  /** Terminal provider status when terminal target. */
  terminal?: "buffer_empty" | "provider_failed";
  /** Foreground / hierarchy resolution hints (H3 bridge). */
  window?: "no_provider_matched" | "dialog_resolved_via_owner_chain" | "parent_disabled_prefer_popup";
  /** Ingress snapshot fetch error (stale cache returned). */
  ingress?: "fetch_error";
  /**
   * One-line summary explaining why entities.length === 0.
   * Only set when entities.length === 0 AND at least one provider signalled a
   * blind/unavailable/failed status. Missing when entities > 0 OR entities === 0
   * but no signalled cause (= genuine empty screen).
   */
  entityZeroReason?:
    | "uia_blind_visual_unready"
    | "uia_blind_visual_empty"
    | "cdp_failed_visual_empty"
    | "all_providers_failed"
    | "foreground_unresolved"
    | "ingress_fetch_error";
}
```

設計理由:

1. **enum 値を warning code の suffix と揃える** → derive ロジックが trivial、docs も 1 本で済む
2. **`entityZeroReason` を optional かつ 1 層の列挙**にする → LLM にとって「空ではない/空だが理由あり/空で理由不明」の三値が読める
3. **provider 単位にキーを分ける** → LLM が「CDP だけ落ちている」「UIA だけ blind」を切り分けやすい

#### 1-2. warnings → constraints マッピング (derive ロジック草案)

```
for w in warnings:
  case "uia_blind_single_pane":         constraints.uia = "blind_single_pane"
  case "uia_blind_too_few_elements":    constraints.uia ??= "blind_too_few_elements"
  case "uia_provider_failed":           constraints.uia ??= "provider_failed"
  case "cdp_provider_failed":           constraints.cdp = "provider_failed"
  case "visual_not_attempted":          constraints.visual = "not_attempted"
  case "visual_attempted_empty":        constraints.visual ??= "attempted_empty"
  case "visual_attempted_empty_cdp_fallback":
                                        constraints.visual ??= "attempted_empty"
                                        constraints.cdp ??= "provider_failed"
  case "visual_provider_unavailable":   constraints.visual ??= "provider_unavailable"
  case "visual_provider_warming":       constraints.visual ??= "provider_warming"
  case "terminal_provider_failed":      constraints.terminal = "provider_failed"
  case "terminal_buffer_empty":         constraints.terminal ??= "buffer_empty"
  case "no_provider_matched":           constraints.window = "no_provider_matched"
  case "dialog_resolved_via_owner_chain": constraints.window ??= "dialog_resolved_via_owner_chain"
  case "parent_disabled_prefer_popup":  constraints.window ??= "parent_disabled_prefer_popup"
  case "ingress_fetch_error":           constraints.ingress = "fetch_error"
  case "partial_results_only":          (no constraint — warning only)
```

優先順位は「より重篤な状態が上書きしない」にするため `??=` (既存なら保持) を原則とし、`uia_blind_single_pane` と `cdp_provider_failed` / `no_provider_matched` のような top-severity シグナルのみ無条件 assign とする。

#### 1-3. `entityZeroReason` の決定論的導出

`entities.length === 0` のときに限り、以下の優先順位で 1 個だけ決める。

```
1. window === "no_provider_matched"                  → "foreground_unresolved"
2. ingress === "fetch_error" (かつ cache 空)          → "ingress_fetch_error"
3. uia blind + visual unready/not_attempted           → "uia_blind_visual_unready"
4. uia blind + visual attempted_empty                 → "uia_blind_visual_empty"
5. cdp provider_failed + visual attempted_empty       → "cdp_failed_visual_empty"
6. uia provider_failed かつ visual provider_failed/empty → "all_providers_failed"
7. それ以外                                            → 設定しない（= 本当に empty）
```

これで `warnings[]` から完全に deterministic に決まる。テストも enumerable。

### Q2. entity-level capability の方針

**結論: `EntityView.capabilities` を optional で追加する。`actionability` は触らない。**

理由:

1. `actionability` は `UiEntityCandidate` / `UiEntity.affordances` と繋がっており、resolver のバーブ合成 (`verbSet`) に直接影響する。terminal entity の `["type"]` を `["read"]` に落とすと、touch 時の `type` action dispatch 自体が壊れて、G2 で用意した WM_CHAR 経路が使われなくなる（回帰）
2. G2 実装では「type は可能だが window が Chromium/UWP の場合のみ unsupported」という構造的事実がある。静的に `canType: false` と言い切れないケースがある（PowerShell / ConEmu / Windows Terminal は可能、Chromium 内 terminal は不可）
3. したがって、H2 段階では「hint として出す」くらいに留めるのが safer

草案 (EntityView だけに足す。UiEntity 本体には足さない):

```ts
export interface EntityView {
  entityId: string;
  label?: string;
  role: string;
  confidence: number;
  sources: string[];
  primaryAction: string;
  lease: EntityLease;
  rect?: { x: number; y: number; width: number; height: number };
  /**
   * Optional negative/positive capability hints for this entity.
   * Advisory — touch may still succeed or fail irrespective of these hints.
   */
  capabilities?: EntityCapabilities;
}

export interface EntityCapabilities {
  /**
   * False when a provider-level constraint makes this verb unreliable for this entity.
   * Missing = no information (default: try normal dispatch).
   */
  canType?: false;
  canClick?: false;
  /** Executor kinds that are expected to work (derived from entity.sources + provider constraints). */
  preferredExecutors?: Array<"uia" | "cdp" | "terminal" | "mouse">;
  /** Executor kinds that have been observed to fail for this target class. */
  unsupportedExecutors?: Array<"uia" | "cdp" | "terminal" | "mouse">;
  /** Human-readable recovery hint (e.g. "use terminal_send V1"). */
  fallbackHint?: string;
}
```

#### 2-1. terminal textbox の取り扱い

terminal textbox entity については以下を行う。

- `actionability: ["type"]` は維持（resolver / executor 経路を壊さない）
- H2 で新設する `capabilities.canType` は **デフォルトでは立てない**
- window class 判定が provider レベルで可能な場合（terminal-provider 内で Chromium/UWP を検出できたとき）のみ `capabilities.canType = false` + `fallbackHint: "use terminal_send V1"` を付ける

これは「実装負荷が大きい場合は段階 1 では `fallbackHint` だけ」でも可 (§6 段階分け参照)。

#### 2-2. 既存テストへの影響

- `tests/unit/desktop-facade.test.ts` の terminal ケース: `actionability` を検査していないため影響なし
- `tests/unit/desktop-providers.test.ts` の terminal provider 単体テスト: `actionability` が `["type"]` のまま維持されれば壊れない
- `EntityView` に optional field 追加のみなので既存 assertion は通る

### Q3. derive ロジックの実装箇所

**結論: `DesktopFacade.see()` の出力組み立て時に `warnings` から derive する。provider 側は structured field を足さない。**

理由:

1. `warnings[]` と `constraints` は additive 関係であり、二重に真実を持たない方が良い (single source of truth = warnings)
2. `compose-providers.ts` 側に structured constraint を足すと、`ProviderResult` の shape が複雑化し、ingress cache entry も膨らむ
3. derive ロジックは pure function として切り出せるのでテストしやすい

実装場所案:

```
新規: src/tools/desktop-constraints.ts
  export function deriveViewConstraints(
    warnings: ReadonlyArray<string>,
    entityCount: number,
  ): ViewConstraints | undefined

改修: src/tools/desktop.ts
  DesktopFacade.see() の最後で
    const constraints = deriveViewConstraints(rawResult.warnings, entityViews.length);
    if (constraints) output.constraints = constraints;
  を挿入
```

`undefined` を返せば既存レスポンスと完全互換（`constraints` キー自体が出ない）。

### Q4. `executor_failed` の pre-emptive surfacing

**結論: view-level は `constraints` に留め、entity-level の `capabilities.fallbackHint` を限定的に活用する。特殊 code (`terminal: "type_via_touch_not_supported"`) は作らない。**

理由:

1. 「terminal で type が必ず失敗する」は事実として誤り（G2 で多くのケースは成功する）
2. pre-emptive に「できない」と宣言するより、**「できない確率が高い状況下では fallback hint を添える」** の方が LLM にとって精度が高い
3. 新コード増殖を避けたい（命令書 §4.3 の contract 保護）

具体策:

- `terminal-provider.ts` 側で window class がわかるとき (`bg-input.ts` の `canBgSend` を事前呼び出し可能なら)、`capabilities.canType = false` + `fallbackHint: "terminal_send_v1"` を terminal textbox entity に付ける
- わからない場合は何も付けない → executor_failed 時の reason を LLM が読む路線は維持

もしこのバッチで bg-input 事前チェックまで入れない判断にする場合、最低限 `desktop_register` の tool description に

> "When a terminal textbox returns executor_failed on type, fall back to V1 terminal_send."

を追記するのが ROI 高い（§Q6 参照）。

### Q5. unit test 追加観点

#### 5-1. 追加すべきテスト

新設: `tests/unit/desktop-constraints.test.ts`

- `deriveViewConstraints` pure function のテーブル駆動テスト
  - 各 warning code に対する constraints field
  - `entityZeroReason` の優先順位テスト (7 ケース)
  - 空 warnings + entities > 0 → `undefined`
  - 空 warnings + entities === 0 → `undefined`（= 本当に empty）
  - multiple warnings + entities === 0 → 1 個の `entityZeroReason`

既存に追加: `tests/unit/desktop-facade.test.ts`

- `see()` の出力に `constraints` が載ることの smoke test（warnings 付き ingress を inject）
- warnings 空 / entities あり のとき `constraints` が存在しないこと
- `EntityView.capabilities` optional (未設定でも既存テスト互換)

既存に追加: `tests/unit/desktop-providers.test.ts`

- terminal-provider が Chromium window class のときに `capabilities.canType = false` を付けるテスト (§Q2 で段階 2 として入れる場合のみ)

#### 5-2. 壊れる可能性があるもの

- `tests/unit/desktop-facade.test.ts`: `expect(out).toEqual({...})` のような全体一致 assertion があれば壊れる。実際には個別 field assertion 中心なので影響小。
- `tests/unit/desktop-register.test.ts`: tool description の spy / snapshot があればそこで壊れる可能性。description 文字列変更時に要確認。
- `tests/unit/desktop-providers.test.ts`: ProviderResult shape を変えないなら影響なし。

### Q6. 推奨 approach (A+B+C どこまでやるか)

**結論: A 全部 + B 最小限 + C 最小限 の段階構成。**

| 手段 | 段階 | ROI | 判断 |
|---|---|---|---|
| A. `ViewConstraints` 追加 + derive | 段階 1 | 最高 | **必須** |
| A. `entityZeroReason` | 段階 1 | 高 | **必須**（instructions の「0 entities 問題」の核） |
| B. `EntityView.capabilities` 型定義 | 段階 1 | 中 | **型だけ追加**（値は段階 2 で詰める） |
| B. terminal Chromium 検出 + `canType:false` | 段階 2 | 中 | **条件付き**（bg-input 事前チェックが軽く呼べるなら入れる。重いなら見送り） |
| C. `desktop_register` description 追記 | 段階 1 | 中 | **必須**（LLM が constraints を読めるよう hint を載せる） |

このバッチで最も ROI が高い変更 = **A の `ViewConstraints` + `entityZeroReason`**。これだけで「0 entities = 空画面」の誤解が構造的に解ける。

---

## 2. 推奨実装計画

### 2.1. Phase 1 (必須): view-level constraints + description 更新

変更ファイル:

| ファイル | 変更内容 |
|---|---|
| `src/tools/desktop.ts` | `DesktopSeeOutput` に `constraints?: ViewConstraints` を optional 追加。`EntityView` に `capabilities?: EntityCapabilities` を optional 追加（型のみ）。`see()` 末尾で `deriveViewConstraints` を呼び、undefined 以外なら `output.constraints = ...` |
| `src/tools/desktop-constraints.ts` (新規) | `ViewConstraints` / `EntityCapabilities` 型定義と `deriveViewConstraints(warnings, entityCount)` pure 関数 |
| `src/tools/desktop-register.ts` | tool description に constraints field の説明と 3-4 行の recovery hint を追記（最小限）|
| `tests/unit/desktop-constraints.test.ts` (新規) | derive pure function のテーブル駆動テスト |
| `tests/unit/desktop-facade.test.ts` | constraints が出る / 出ないケースの smoke test 追加 |

注意:

- **既存 warning コードの追加・削除・rename は禁止**（contract 保護）
- `ViewConstraints` は additive（`warnings[]` は残る）
- derive 関数は pure、I/O なし

### 2.2. Phase 2 (条件付き): terminal capability hint

以下を Phase 1 完了後に判定し、実装負荷が軽ければ入れる。重ければ H2.5 / H5 に繰越。

変更ファイル:

| ファイル | 変更内容 |
|---|---|
| `src/tools/desktop-providers/terminal-provider.ts` | `bg-input.canBgSend` を事前呼び出しし、unsupported window 時に textbox entity の候補段階で `capabilities` hint を付ける経路を検討（`UiEntityCandidate` → `UiEntity` → `EntityView` の map を最小侵襲で通す） |
| `src/tools/desktop.ts` | `see()` 内で `EntityView.capabilities` を entity → view map 時に設定 |
| `tests/unit/desktop-providers.test.ts` | Chromium class 検出時の capability hint テスト |

`UiEntityCandidate` に capability field を持たせるか、resolver の出力 `UiEntity` に足すかは実装時判断。どちらも `EntityView` 変換時に反映できれば良い。

### 2.3. やらないこと (このバッチのスコープ外)

- `warnings[]` の削除 / rename / 構造変更
- `actionability` の変更（resolver / executor contract を壊すため）
- `UiAffordance.preconditions` / `postconditions` の実体化
- release / version bump / tag / publish
- capability schema の「全面」設計
- common dialog / window hierarchy の追加改修（H3 で着地済み）
- visual lane の追加昇格（H4 で着地済み）

### 2.4. 完了条件 (§10 との対応)

1. `desktop_see` の response に `constraints` が optional で出る
2. `entities.length === 0` のとき、原因が特定できれば `entityZeroReason` が付く
3. 既存 `warnings[]` / test expectations が壊れていない
4. `npm run build` と `tests/unit/desktop-*.test.ts` が green

### 2.5. 推奨 commit メッセージ

```
feat(facade): surface negative capability hints in desktop_see responses
```

---

## 3. Opus レビュー観点 (CLAUDE.md §強制命令 3)

Phase 1 実装完了時点で Opus レビューに出すべき 4 点:

1. `ViewConstraints` の enum 値が 6 か月後も stable か（新 warning code 追加時の命名規約を一緒に決めるべきか）
2. `entityZeroReason` の優先順位が dogfood 再現シナリオ（S1–S5）に対して妥当か
3. `EntityView.capabilities` を Phase 1 で「型だけ」入れて値を空のまま出す方針が、将来の破壊的変更を招かないか
4. derive ロジックを facade に置くのと provider / ingress に置くので、ingress cache と ABI に影響がないか

---

## 4. リスクと mitigant

| リスク | mitigant |
|---|---|
| `constraints` が常に出て tool response 肥大化 | `undefined` 時は field 自体を出さない（JSON 的に absent） |
| LLM が `constraints.visual = "attempted_empty"` を見て visual 常用を要求 | description で「fallback hint であり、常用ではない」と明示 |
| terminal `capabilities.canType = false` が誤判定で正常ケースを阻害 | Phase 2 に閉じる。Phase 1 では型のみで値は付けない |
| `entityZeroReason` 7 ケースの網羅漏れ | テーブル駆動 unit test で enumerate。追加は additive で OK |
| 既存 snapshot テストで shape 変更が detect | `constraints` / `capabilities` は optional のため absent のままなら一致する |
