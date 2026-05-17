# ADR-020 Phase 3 SR-5 — `"keyboard"` first-class promotion sub-plan

- Status: **Drafted (2026-05-17、Round 2 = Opus R1 P1×2 + P2×6 + P3×4 + §3.2 sweep 発見 (engine field shape 拡張) 全件反映、累積 13 件 closure)**
- 親 ADR: `docs/adr-020-path-class-refactor-plan.md` §5.1 SR-5
- 着手 trigger: ADR-020 SR-1 全 PR land 完了 (PR #339-#342 merged、main HEAD `2e79f4d`)
- baseline commit: `2e79f4d` (main HEAD、PR-SR1-2 merge 後)
- 着手順序: Phase 3 4 SR のうち **2 番目** (SR-1 → **SR-5** → SR-2 → SR-4、親 ADR §5.1)
- 関連 SSOT: `src/engine/world-graph/types.ts:36` `ExecutorKind` (既に `"keyboard"` 含む) / `src/capabilities/registry.ts:39` `AdvertisedExecutorKind` (現状 4 executor narrow) / `src/tools/desktop-executor.ts` 4 block sequential / `src/tools/desktop-register.ts:800` advisoryRegistry 経由 description
- 北極星抜粋 (親 ADR §2 から SR-5 への refinement): **`"keyboard"` を advertised executor に昇格、LLM が `preferredExecutors` で明示選択可能化**、既存 PR #330 contract (内部 UIA→keyboard recovery で bare `"keyboard"` return) は **bit-equal 維持**
- 関連 OQ: **OQ-SR5-1** (SR-1 sub-plan §9 で carry-over、本 SR-5 で必ず exit condition のいずれかを明示判断、§5 で確定)

---

## 1. 背景

### 1.1 PR #330 で内部導入された `"keyboard"` の現状

PR #330 (Issue #327 item E、2026-05-08 merged) で `keyboardTypeBg` (`src/engine/bg-input.ts::postCharsToHwnd` 経由 WM_CHAR injection) を **UIA setValue 失敗時の internal-only fallback** として導入。`src/engine/world-graph/types.ts:36` `ExecutorKind` 型に `"keyboard"` を含めたが、JSDoc (line 25-35) で「`"keyboard"` is a sub-executor used as a fallback ... NOT a primary executor advertised in `UiAffordance.executors` or `unsupportedExecutors`」と明記、advertise 対象外。

baseline (`2e79f4d`) 状態:
- `ExecutorKind = "uia" | "cdp" | "terminal" | "mouse" | "keyboard"` (5 executor 含、internal `"keyboard"` ✓)
- `AdvertisedExecutorKind = "uia" | "cdp" | "terminal" | "mouse"` (4 executor narrow、SR-1 PR-SR1-1 で確立、`"keyboard"` 除外)
- `ALLOWED_EXECUTORS` Set: 4 executor のみ (registry runtime invariant、`"keyboard"` 注入は throw)
- `EntityCapabilities.preferredExecutors / unsupportedExecutors` 型: `AdvertisedExecutorKind[]` (4 executor narrow)
- `createDesktopExecutor` 4 block sequential (UIA / CDP / terminal / mouse)、UIA route 内に keyboardTypeBg fallback (line 198-215)
- `desktop-register.ts:800` tool description: `["uia","cdp","terminal","mouse"]` 4 executor advertise

### 1.2 SR-5 動機 (親 ADR §5.1 + Issue #327 item E 教訓)

**現状の問題**:
1. **LLM が `"keyboard"` を明示選択不能**: 例えば「Notepad の RichEditD2DPT を確実に type で扱いたい」場合、LLM は UIA を選んで内部 fallback で keyboard に降りるのを待つしかない (= advertise 経路なし)
2. **`preferredExecutors: ["keyboard"]` だけの entity advertise 不能**: UIA-blind な native text input (e.g. games with custom text fields exposing only WM_CHAR) を直接 keyboard executor で扱いたいが、現状は UIA block を通る必要
3. **tool description で keyboard executor を advertise しない**: LLM 側の知識として `"keyboard"` executor が利用可能とは認識されていない (`desktop-register.ts:800` advertise は 4 executor のみ)

**SR-5 解決**:
1. `AdvertisedExecutorKind` を 4 → 5 executor (`"keyboard"` 追加) に拡張、`ALLOWED_EXECUTORS` Set も同期
2. `registry.lookup` rule table を拡張: `KeyboardWritable` 検出ロジック追加で `preferredExecutors: ["uia", "keyboard"]` / `["keyboard"]` 等を emit
3. `desktop-executor.ts` に **5 番目 keyboard block** を追加 (4 block sequential → 5 block sequential)、`preferredAllows("keyboard")` check + `d.keyboardTypeBg` direct call
4. `desktop-register.ts:800` tool description で `"keyboard"` advertise (SR-1 PR-SR1-3 で land した `toolDescriptionAdvisory()` 経由)
5. CHANGELOG entry (CLAUDE.md 強制命令 10、user-facing)
6. **OQ-SR5-1 exit condition 明示判断**: 内部 UIA→keyboard recovery の marker emit を本 sub-plan で確定 (§5)

### 1.3 PR-SR1-2 で carry-over した OQ-SR5-1 (sub-plan §9)

SR-1 PR-SR1-2 で「内部 keyboard fallback marker emit 一般化は SR-5 で必ず判断」とした OQ-SR5-1 が本 sub-plan の **核心判断項目**。exit condition 3 案:
1. **keep bare keyboard as final contract**: 現状維持、UIA route 内 internal recovery で bare `"keyboard"` return、downgrade marker emit なし
2. **emit downgrade metadata + update contract tests intentionally**: UIA→keyboard recovery で `{kind: "keyboard", downgrade: {from: "uia"}}` emit、PR #330 contract 意図的更新、test 書換含む
3. **introduce separate `fallbackChain` / `attemptedExecutors` field**: `kind: "keyboard"` bare 維持しつつ別 field で attempt 履歴を `ExecutorOutcome` に追加

**Round 1 推奨 (本 sub-plan で確定): 案 (1) keep bare keyboard as final contract**。詳細は §5 OQ-SR5-1 closure 参照。

### 1.4 KeyboardWritable 判定軸 (Round 1 で詳細化)

「`"keyboard"` を `preferredExecutors` に emit する entity」の判定軸を rule table に組込 (Round 2 P1-2 反映で「現状 emit」を `hasInvoke` 優先順位含めて分岐明示):

| entity 特性 | 現状 emit (baseline `registry.ts::lookupDefault` 逐行確認済) | SR-5 emit (Round 2 確定) |
|------------|---------|---------|
| UIA + `InvokePattern` あり (`hasInvoke` 優先、Button + ValuePattern 両持ち Edit 含む) | `["uia", "mouse"]` (`registry.ts:144-145` Case Invoke 行) | **`["uia", "mouse"]` 維持** (本 SR-5 で touch しない、Invoke 優先 = click action 中心の entity で keyboard 共起 advertise する LLM 観測需要が無い、Phase 2 E contract test `e-uia-fallback-ladder.test.ts:62-71` の Invoke + ValuePattern pin 維持) |
| UIA + `ValuePattern` あり (`hasValue` only、`hasInvoke === false`、Edit / ComboBox / Document の text-input core) | `["uia"]` (`registry.ts:159-160` Case Value 行、本 case が SR-5 改修対象) | **`["uia", "keyboard"]`** (UIA setValue 優先 + keyboard 直行 fallback advertise、SR-5 改修の core) |
| UIA + `KeyboardWritable` 単体 (ValuePattern なし、controlType が `RichEdit`/`Document` 等 + KeyboardWritable check pass) | 該当 case で hit する path がなければ末尾 rect fallback で `["mouse"]` (`registry.ts:163-167` Case 5) | **本 SR-5 で touch しない** (OQ-SR5-2 で SR-5 完了後判断、§9) |
| 他 (Button without ValuePattern / List / Tab / Toggle / SelectionItem / visual_gpu) | 既存通り | 既存通り (keyboard 追加なし) |

**判定軸の特化** (Round 2 P1-2 反映): SR-5 の rule table 改修対象は **`hasValue` ブランチ (line 159-160) のみ**、`hasInvoke` ブランチ (line 144-145) は SR-5 では touch しない。理由:
- `hasInvoke` ブランチは「Button click が primary affordance」前提、text 入力は secondary。`["uia", "mouse"]` で UIA Invoke 優先 + mouse fallback は既存 contract (PR #332 UIA→mouse hand-wired marker 維持)、keyboard 共起 advertise は LLM 観測需要が顕在化していない (Round 1 で曖昧、Round 2 で「本 SR-5 で touch しない」と確定して Phase 2 E contract test の bit-equal 維持確保)
- `hasValue` only ブランチは「ValuePattern entity の text 入力が primary」、UIA setValue 失敗時 (RichEditD2DPT 等) の keyboard fallback 経路を advertise する意義最大、SR-5 改修の core target

`KeyboardWritable` 判定の **2 軸 dependency** (Round 2 P3-2 反映で明示):
- **(a) UIA `IsKeyboardFocusable` API 連携**: 現コードに helper **未実装** (`Grep IsKeyboardFocusable` 0 件確認)、SR-5 で新規実装が必要 (UIA Rust addon `src/uia/tree.rs` 拡張 + napi binding 追加)
- **(b) WM_CHAR injection 可能 hwnd 判定**: `src/engine/bg-input.ts:163-165` `canInjectAtTarget(hwnd)` 既存実装あり、`KeyboardWritable` 単体判定でそのまま流用可能

= **(a) が新規実装必要**で本 SR-5 scope 外、OQ-SR5-2 で SR-5 完了後 dogfood 観察 → 必要なら別 epic / 後続 SR で対応。

---

## 2. 北極星 (SR-5 不変条件)

親 ADR §2 北極星 4 件 + SR-1 北極星 6/7/8/9 を継承 + SR-5 layer に refinement:

1. **`AdvertisedExecutorKind` 5 executor 拡張で registry SSOT 維持**: `src/capabilities/registry.ts` の `AdvertisedExecutorKind` を `"uia" | "cdp" | "terminal" | "mouse" | "keyboard"` に拡張、`ALLOWED_EXECUTORS` Set も同期、type 1 箇所改修で全 production code に narrow 拡張が伝播 (SR-1 北極星 7 (c) の延長)。
2. **PR #330 contract 維持 (bare `"keyboard"` return)**: UIA route 内 keyboardTypeBg recovery (`uiaSetValue` throw → `keyboardTypeBg` succeed) は **bare `"keyboard"` return 維持** (OQ-SR5-1 exit condition (1) 採用、§5 で確定)。`tests/unit/desktop-executor.test.ts` 既存 case + Phase 2 E contract test の bare expect は **書換禁止** (CLAUDE.md `feedback_sonnet_test_executor.md` 遵守)。
3. **5 block sequential 構造で baseline 4 block を bit-equal 維持**: 新 keyboard block を mouse block の **直前** (UIA / CDP / terminal / **keyboard** / mouse) に挿入、`preferredAllows("keyboard")` check で entry gate。既存 4 block の内部 logic / fallback / error message / return shape は完全 bit-equal (SR-1 北極星 9 (2) の延長)。
4. **既存 public API 不破壊**: `ExecutorKind` type / `ExecutorOutcome` shape / `EntityCapabilities.preferredExecutors` 型 (string union 拡張のみ、shape は同じ) / `createDesktopExecutor` signature / tool description wire (advisory text 追加のみ、既存 4 executor 文言は維持) — 全て backward compatible (親 ADR §3 北極星 3 + 強制命令 10 整合)。
5. **CHANGELOG entry 必須** (CLAUDE.md 強制命令 10): `"keyboard"` advertised executor 新規追加は user-visible change、What changed / Why / How to use 三本柱で entry 起草。
6. **OQ-SR5-1 exit condition 明示判断**: 案 (1) keep bare keyboard as final contract を採用、§5 で根拠 + carry-over closure 明示。

---

## 3. scope outline (2 PR 分割 + 並走条件)

ADR-020 §5.1 SR-5 「~400-600 line + CHANGELOG」を **2 PR 構成** に確定 (PR-SR1 の 3 PR より小規模、type 拡張 + executor block 追加 + description + CHANGELOG が主):

```
PR-SR5-1 (registry + type 拡張 + rule table 拡張 + engine field shape 拡張 + tool description、~250-350 line、Round 2 で engine field shape 拡張追加)
   = src/capabilities/registry.ts: AdvertisedExecutorKind / ALLOWED_EXECUTORS に "keyboard" 追加 (1 type alias 改修 + Set 1 行)
   = src/engine/world-graph/types.ts:148: UiEntity.preferredExecutors engine field inline shape を
     Array<"uia"|"cdp"|"terminal"|"mouse"> → Array<"uia"|"cdp"|"terminal"|"mouse"|"keyboard"> に拡張
     (Round 2 Opus §3.2 sweep 発見、AdvertisedExecutorKind 拡張に inline shape が automatically 追随しないため別途必要)
   = src/capabilities/registry.ts:lookupDefault rule table 拡張: hasValue only ブランチ (line 159-160) に
     preferredExecutors: ["uia", "keyboard"] emit (hasInvoke ブランチは touch しない、§1.4 P1-2 確定)
   = src/capabilities/registry.ts:ADVISORY_TEXT (PR-SR1-3 で land 済 const) を keyboard 言及含む文言に更新
   = tests/unit/desktop-register-tool-description.test.ts 5 assertion (snapshot / EXPECTED_ADVISORY bit-equal /
     immutable 2 ×same instance / startsWith / endsWith) **全件更新** + snapshot regen (Round 2 P1-1 反映)
   = tests/unit/desktop-capabilities.test.ts 14 case 中 ValuePattern only 行 1 case (line 89 周辺) を新 contract に合わせて
     1 行更新 (preferredExecutors: ["uia"] → ["uia", "keyboard"]、新 contract land 意図的更新、§4.5 で SSOT 明示)
   = tests/unit/capabilities-registry-invariant.test.ts 17 case 中 keyboard smuggle 1 case (line 113-122 周辺) を
     ALLOWED_EXECUTORS に "keyboard" 含む状態で逆転 (smuggle pass → smuggle reject 軸を別の不正 executor に切替)
   = uia-provider.ts JSDoc 文言は触らない (SR-1 で更新済、SR-5 で新規 keyboard 言及は description 経由のみ)
   ↓
PR-SR5-2 (executor 5 番目 keyboard block + 新規 test + CHANGELOG、~200-300 line)
   PR-SR5-1 land 後着手 (型依存 = AdvertisedExecutorKind 5 executor 拡張済前提、Round 2 P3-3 反映で並走不可明示)
   = src/tools/desktop-executor.ts: createDesktopExecutor に 5 番目 keyboard block 追加
     (UIA / CDP / terminal / [keyboard] / mouse の sequential、新 block 到達条件は §5.2 で明示)
   = keyboard block: preferredAllows("keyboard") check + text + (type | setValue) gate + d.keyboardTypeBg direct call
     + bare "keyboard" return (PR #330 contract 維持、OQ-SR5-1 exit condition (1))、throw 直伝播 (CDP/terminal と同 pattern)
   = UIA route 内の既存 keyboardTypeBg fallback (line 198-215) は bit-equal 維持 (北極星 2)
   = mouse fallback の text drop 防止 throw (line 275-280) は keyboard 経由可能性を考慮した文言に更新
     (text drop throw 3 case (line 511 / 529 / 561) を §5.4 で個別更新明示、Round 2 P2-5 反映)
   = 新規 test: preferredExecutors=["keyboard"] 直接経路 + preferredExecutors=["uia","keyboard"] 両 case
     (到達経路の違いを §5.4 で明示、Round 2 P2-3 反映)
   = Phase 2 E contract test 拡張可能性 (本 sub-plan §5 で確定): bare "keyboard" return 維持 pin 強化
   = CHANGELOG entry (user-facing、CLAUDE.md 強制命令 10、§7 で文面起草、Round 2 で内部 PR # 削除 + WT-XAML fail-soft 動作追加)
```

並走条件: **PR-SR5-2 は PR-SR5-1 land 後着手** (型依存、Round 2 P3-3 反映で worktree 並走不可明示)。SR-1 PR-SR1-2/-3 は scope disjoint で並走可能だったが、SR-5 は型拡張が executor block 追加の前提で順序依存。

**PR-SR5-0 (sub-plan land)**: 本 sub-plan を `.gitignore` whitelist 追加 + docs-only PR で先に land (SR-1 PR-SR1-0 と同 pattern、先例 #339)。

---

## 4. PR-SR5-1 詳細 (registry + type 拡張)

### 4.1 目的

`src/capabilities/registry.ts` の `AdvertisedExecutorKind` を 4 → 5 executor (`"keyboard"` 追加) に拡張、`ALLOWED_EXECUTORS` Set も同期、`lookupDefault` rule table の `ValuePattern` 行を `["uia"]` → `["uia", "keyboard"]` に拡張。tool description の `ADVISORY_TEXT` を keyboard 言及含む文言に更新。registry SSOT 1 箇所改修で全 production code に narrow 拡張が伝播 (北極星 1)。

### 4.2 主要変更 (`src/capabilities/registry.ts`)

```ts
// Round 1 草案 (PR-SR5-1)

// (1) type alias 拡張 (1 行改修)
export type AdvertisedExecutorKind = "uia" | "cdp" | "terminal" | "mouse" | "keyboard";

// (2) ALLOWED_EXECUTORS Set 拡張 (1 行追加)
const ALLOWED_EXECUTORS: ReadonlySet<AdvertisedExecutorKind> = new Set<AdvertisedExecutorKind>([
  "uia",
  "cdp",
  "terminal",
  "mouse",
  "keyboard",  // ← SR-5 で追加
]);

// (3) lookupDefault rule table 拡張 (1 case 行修正、Round 2 P3-N1 で line 数訂正)
// 現状 (`src/capabilities/registry.ts:159-160` Case Value 行、`hasValue` only branch):
//   if (hasValue) {
//     return { preferredExecutors: ["uia"] };
//   }
//
// SR-5 で:
//   if (hasValue) {
//     return { preferredExecutors: ["uia", "keyboard"] };  // ValuePattern entity に keyboard 共起 advertise
//   }
```

**KeyboardWritable 単体 case (ValuePattern なし) の判定は §1.4 で「OQ-SR5-2 で SR-5 完了後判断」**として保守的 scope に留め、Round 1 では **`ValuePattern` 検出のみで `"keyboard"` 共起 advertise** に絞る。理由:
- `KeyboardWritable` 単体判定の helper が現コードに無く、新規追加が必要 (UIA `GetIsKeyboardFocusable` API + `canInjectAtTarget` の組合せ判定 helper、現状 `bg-input.ts` 内に partial 実装)
- 過剰 advertise (= entity が実際には keyboard 受け取らない case で `["keyboard"]` emit) は LLM の誤判断招く risk
- **保守的 scope で SR-5 を land**、KeyboardWritable 単体軸は OQ-SR5-2 で SR-5 完了後 dogfood 観察 → 必要なら別 epic

### 4.3 ADVISORY_TEXT 更新 + snapshot test (Round 2 P1-1 + P2-2 反映で 5 assertion 全更新明示)

```ts
// src/capabilities/registry.ts (PR-SR1-3 で land 済 ADVISORY_TEXT を更新)
// 注意 (Round 2 P2-2): 下記の "// ── ADR-020 SR-5 で追加 ──" は TS コメントで
// runtime 文字列に含まれない。Sonnet 実装時に文字列内に内部 SR 番号 / PR # /
// reviewer round 番号等を埋め込まないこと (CLAUDE.md 強制命令 10、user-facing
// 文言で内部 plan tracking 用語禁止)。

const ADVISORY_TEXT =
  "Issue #296: entities[].capabilities (when present) advises executor selection. " +
  "preferredExecutors[0] is the executor most likely to succeed; " +
  "if unsupportedExecutors contains 'uia', go straight to mouse_click instead of click_element " +
  "(saves a InvokePatternNotSupported round-trip on ListItem / TabItem / custom-drawn controls). " +
  // ── ADR-020 SR-5 で追加 (TS コメント、runtime 文字列に含まれない) ──
  "When preferredExecutors contains 'keyboard' (e.g. ['uia','keyboard'] on text inputs), " +
  "the 'keyboard' executor injects WM_CHAR directly to the focused control without focus-steal, " +
  "useful when UIA setValue fails on RichEdit/Document controls with unstable locators.";
```

`tests/unit/desktop-register-tool-description.test.ts` の **5 assertion 全件更新必須** (Round 2 P1-1 反映、Opus が指摘した snapshot regen + endsWith 見落とし risk):

1. **snapshot assertion**: `__snapshots__/desktop-register-tool-description.test.ts.snap` 自動 regen (`npx vitest --update`)、新 ADVISORY_TEXT 全文 bit-equal pin
2. **`EXPECTED_ADVISORY` bit-equal assertion**: const 内 expect 文字列を新 ADVISORY_TEXT に同期更新
3. **`immutable` (toBe 2 × same instance)**: 動作変わらず (同 instance return 維持)、新 const literal で同じ pattern
4. **`startsWith("Issue #296:")` assertion**: SR-5 で prefix 不変、現状維持で OK
5. **`endsWith(...)` assertion**: 現状 `"...controls)."` → SR-5 後 `"...UIA setValue fails on RichEdit/Document controls with unstable locators."` 等の新 suffix に更新

`registry.toolDescriptionAdvisory()` 出力 prefix 構造維持 (`"Issue #296:"` 始まり、末尾は SR-5 で keyboard 言及追加で終わる)。

### 4.4 acceptance (PR-SR5-1、Round 2 で engine field shape 拡張 + numeric SSOT 明示)

- `AdvertisedExecutorKind` 5 executor 拡張 + `ALLOWED_EXECUTORS` Set 同期 (北極星 1)
- **`UiEntity.preferredExecutors` engine field shape 拡張** (`src/engine/world-graph/types.ts:148`、Round 2 Opus §3.2 sweep 発見): `Array<"uia"|"cdp"|"terminal"|"mouse">` → `Array<"uia"|"cdp"|"terminal"|"mouse"|"keyboard">` (AdvertisedExecutorKind 拡張に inline shape が自動追随しないため別途必要、`bakeEntityCapabilities` 経由 bake 時に "keyboard" 含む配列を engine field に書込可能にする)
- `lookupDefault` rule table `hasValue` only case (`registry.ts:159-160`) → `["uia", "keyboard"]` emit (`hasInvoke` ブランチは touch しない、§1.4 P1-2 確定)
- `ADVISORY_TEXT` 更新 (keyboard 言及追加、`Issue #296:` prefix 維持、`──ADR-020 SR-5 で追加──` コメントは TS comment で runtime 文字列に含まれないこと §4.3 で明示)
- **既存 test 意図的更新 (新 contract land、CLAUDE.md `feedback_sonnet_test_executor.md` 例外、sub-plan SSOT 明示)**:
  - `desktop-capabilities.test.ts` 14 case 中: `ValuePattern (Edit)` 行 1 case (`line 93-104` 周辺) を `preferredExecutors: ["uia"]` → `["uia", "keyboard"]` に更新
  - `capabilities-registry-invariant.test.ts` 17 case 中: keyboard smuggle 1 case (`line 113-122` 周辺) を逆転 (smuggle pass → 別の不正 executor 注入 reject 軸に置換、e.g. `"unknown_executor"` 注入で throw)
  - **Phase 2 C contract test (`c-executor-downgrade.test.ts:69-72`) table case 2** (Round 3 実装中追加発見、Opus Round 1/2 review で見落とし): `ValuePattern only` 行で `expectedPreferred: ["uia"]` → `["uia","keyboard"]` (registry rule table 改修に追随、Phase 2 C contract が registry 出力を wire-level pin する設計のため、SR-5 で registry rule table 改修すると 1 case の expectedPreferred 更新が論理的必須)
  - その他 13 + 16 + 6 = 35 既存 case は **無変更** (baseline 完全同一動作 pin)
- snapshot test (`desktop-register-tool-description.test.ts`) **5 assertion 全件更新** (Round 2 P1-1 反映、§4.3 で明示):
  - snapshot file regen + EXPECTED_ADVISORY const + immutable 2 assertions + startsWith + endsWith
- Phase 2 contract test 5 件中 4 件 (D/F/B/E) 全 green 維持 (`d-modal-classifier.test.ts` / `f-lease-ttl.test.ts` / `b-dxgi-cache-state.test.ts` / `e-uia-fallback-ladder.test.ts` は本 PR で touch しない)、C 軸 (`c-executor-downgrade.test.ts`) は table case 2 を意図的更新で同期
- `npm run build` (tsc clean) + `npm test` (vitest pass)
- Opus phase-boundary review + Codex 1+ round (production code 改修、§3.3 Step 0)

### 4.5 risk

- **R-SR5-1-a**: `AdvertisedExecutorKind` 拡張で `EntityCapabilities.preferredExecutors` 型が広がるため、本 PR で touch しない他 callsite (e.g. SR-1 で land 済 helper) が `"keyboard"` を含む配列を受け取って想定外動作する risk。**対策**: `git grep AdvertisedExecutorKind` で全 callsite を full read、preferredExecutors 配列を直接 read している箇所 (PR-SR1-2 で land した `desktop-executor.ts` の preferredAllows check) が `"keyboard"` を含む配列で正常動作するか確認 (PR-SR5-2 で 5 番目 block 追加までは `"keyboard"` を含む配列は registry rule table から emit されない、PR-SR5-1 と PR-SR5-2 は依存順序遵守必須)
- **R-SR5-1-b**: 既存 test 書換禁止 (CLAUDE.md `feedback_sonnet_test_executor.md`) との衝突。**対策**: 本 PR scope は新 contract land で **意図的 test 更新** が必要、sub-plan で明示的に「PR-SR5-1 で land する新 contract」として記録、commit message + PR description に「14 case 中 ValuePattern 行 1 case + 17 case 中 keyboard smuggle 1 case を新 contract に合わせて更新」明記、Sonnet 単独判断ではなく sub-plan SSOT に従う形

---

## 5. PR-SR5-2 詳細 (executor 5 番目 keyboard block + OQ-SR5-1 closure)

### 5.1 目的

`createDesktopExecutor` に **5 番目 keyboard block** を mouse block の直前に追加 (UIA → CDP → terminal → **keyboard** → mouse の 5 block sequential)、`preferredAllows("keyboard")` check で entry gate。既存 4 block は **bit-equal 維持** (北極星 3)、UIA route 内 keyboardTypeBg fallback (line 198-215) も **完全 bit-equal 維持** (北極星 2、OQ-SR5-1 exit condition (1))。

### 5.2 `createDesktopExecutor` 改修 outline (PR-SR5-2)

```ts
// src/tools/desktop-executor.ts 改修 (5 番目 block 追加、~50 行追加)

// 既存 4 block (UIA / CDP / terminal) + 新 keyboard block + 既存 mouse fallback の sequential

// ── 既存 UIA block (bit-equal 維持) ────────────────────────────────────────
// ... 既存 logic (line 183-236)、UIA route 内 keyboardTypeBg recovery で bare "keyboard" return 維持

// ── 既存 CDP block (bit-equal 維持) ────────────────────────────────────────
// ... 既存 logic (line 242-252)

// ── 既存 terminal block (bit-equal 維持) ────────────────────────────────────
// ... 既存 logic (line 260-264)

// ── ★ 新規 keyboard block (PR-SR5-2 で追加、mouse block の直前) ─────────────
// 北極星 9 (1) baseline 完全同一動作維持: `entity.preferredExecutors === undefined`
// (test 直 invoke / legacy path) の case で新 keyboard block を entry させないため、
// `preferredAllows("keyboard")` (undefined 時 true 返却) ではなく explicit な
// `entity.preferredExecutors !== undefined && includes("keyboard")` で gate する
// (Round 3 実装中追加発見、preferredAllows semantic との組合せ sweep miss を修正)。
// 注意: text 必須 (keyboard は WM_CHAR injection 専用、click action では入れない)
if (
  entity.preferredExecutors !== undefined &&
  entity.preferredExecutors.includes("keyboard") &&
  !blocked.includes("keyboard") &&
  text !== undefined &&
  (action === "type" || action === "setValue")
) {
  // UIA route 内 fallback の keyboardTypeBg を direct invoke
  // 失敗時は throw 直伝播 (CDP/terminal と同 pattern、generic mouse rescue しない、北極星 9 (3) の延長)
  await d.keyboardTypeBg(resolveWindowTitle(target), text);
  return "keyboard";  // bare return (PR #330 contract 維持、OQ-SR5-1 exit condition (1))
}

// ── 既存 mouse fallback (bit-equal 維持) ────────────────────────────────────
// text drop 防止 throw 文言は keyboard 経由可能性を考慮して文言更新検討 (§5.4 acceptance)
```

**重要 design 決定**:
- **keyboard block は text + setValue/type 必須** (action === "click" 等では entry しない、click は keyboard で意味なし)
- **失敗時 throw 直伝播** (CDP / terminal と同 pattern、generic mouse rescue しない、北極星 9 (3) 整合)。`preferredExecutors=["keyboard"]` + keyboardTypeBg failure 時は throw 直伝播 → guarded-touch 経由で `executor_failed` (mouse rescue しない、R-SR5-2-c 詳細)
- **UIA route 内 keyboardTypeBg fallback は bit-equal 維持** (PR #330 contract、OQ-SR5-1 exit condition (1) で「現状 bare return final contract」採用)
- **mouse fallback の text drop 防止 throw 文言更新**: 現状「`(uia=blocked/no-source, cdp=blocked/no-selector, terminal=blocked/no-source-or-text) — mouse fallback would drop the text payload`」に keyboard も含める必要 (PR-SR5-2 で更新、bit-equal pin が変わるが新 contract land の意図的更新)

**新 keyboard block 到達条件** (Round 2 P2-3 反映で明示):

新 keyboard block が **実際に entry されるのは限定 case のみ**:
1. `preferredExecutors=["keyboard"]` 単独 set (UIA 排除) + (a) `sources` に "uia" 含まない or (b) `unsupportedExecutors.includes("uia")` で uiaBlocked → UIA block skip → CDP/terminal eligibility なし → **新 keyboard block entry → bare "keyboard" return**
2. `preferredExecutors=["cdp","keyboard"]` 等で CDP も含む multi-source + CDP eligibility なし + UIA eligibility なし → 新 keyboard block entry (現実的にはレア case)

**新 keyboard block が到達しない case** (= 典型 `preferredExecutors=["uia","keyboard"]` entity):
- `sources: ["uia"]` + `preferredExecutors: ["uia","keyboard"]` + ValuePattern entity → UIA block entry (preferredAllows("uia") true) → UIA setValue 内部 ladder で keyboardTypeBg 発火 (line 198-215) → **UIA block 内 fallback で bare "keyboard" return** (新 block は到達せず、北極星 2 維持)
- `sources: ["uia"]` + `preferredExecutors: ["uia","keyboard"]` + UIA setValue 成功 → UIA block 内 bare "uia" return (新 block 到達せず)

= 新 keyboard block は **「UIA 経由を完全に排除した text 入力経路」** を opening する設計、典型 ValuePattern entity (UIA + keyboard 共起 advertise) の動作は **UIA block 内 既存 fallback で完結**して bit-equal 維持 (北極星 2)。LLM advertise 上の `["uia","keyboard"]` は UIA を 1st 候補で試す形で SR-5 の意義 (= UIA setValue 失敗時の keyboard recovery 経路を明示 advertise) を達成。

### 5.3 OQ-SR5-1 exit condition closure (本 SR-5 確定)

**採用案: (1) keep bare keyboard as final contract**

**根拠**:
1. **PR #330 contract 維持 = backward compatible 最優先**: `tests/unit/desktop-executor.test.ts` 既存 case + Phase 2 E contract test (`e-uia-fallback-ladder.test.ts`) が `outcome === "keyboard"` (bare ExecutorKind) を強く expect、案 (2) で書換は CLAUDE.md `feedback_sonnet_test_executor.md` 違反 risk 高
2. **5 番目 keyboard block 追加で advertise 経路は別途実現**: LLM が `preferredExecutors: ["keyboard"]` で明示選択する場合は 5 番目 block で bare `"keyboard"` return、UIA route 内 internal recovery も bare 維持 — どちらも同じ contract で **観測性 / 一貫性両立**
3. **案 (3) `fallbackChain` 別 field は YAGNI**: 現状の dogfood で「UIA→keyboard recovery 履歴を LLM が観測したい」需要が顕在化していない、観測必要なら post-SR-5 で別 epic (ADR-021 etc.) で追加可能
4. **案 (2) downgrade marker emit は SR-1 北極星 9 (5) と整合難**: 「UIA → mouse downgrade marker は UIA block 内 hand-wired emit 維持」と並立させると「UIA → keyboard も同 emit path」になり、PR #332 hand-wired と PR #330 bare return の **2 contract が併存** する形で混乱招く

**SR-5 で closure**: OQ-SR5-1 を本 sub-plan §5.3 で **(1) keep bare keyboard as final contract** に確定、親 ADR §11 ledger L4 (E 軸) を SR-5 構造除去対象として明示、closure 後 ledger strikethrough。

**Double-link to SR-1 sub-plan §9** (Round 2 P2-6 反映、carry-over closure 双方向リンク化): SR-1 sub-plan `docs/adr-020-phase-3-sr-1-capability-registry-plan.md` §9 OQ-SR5-1 が「SR-5 sub-plan で本 OQ-SR5-1 への参照 + exit condition 達成の明示が必須」と pin している (CLAUDE.md 強制命令 9 整合)。本 SR-5 sub-plan §5.3 = OQ-SR5-1 closure declaration、SR-1 sub-plan §9 ↔ 本 §5.3 で双方向 cross-link 成立。SR-5 全 PR land 完了時に SR-1 sub-plan §9 OQ-SR5-1 entry を `~~OQ-SR5-1 (Resolved by SR-5 sub-plan §5.3 with exit condition (1))~~` に strikethrough 化 (SR-1 sub-plan は merged 済 docs だが将来読者の navigation 効率化のための post-merge edit、CLAUDE.md 強制命令 9 「残件 docs/ 永続化」整合)。

### 5.4 acceptance (PR-SR5-2)

- 5 番目 keyboard block 追加 (`preferredAllows("keyboard")` check + `d.keyboardTypeBg` direct call + bare `"keyboard"` return)
- 既存 4 block (UIA / CDP / terminal / mouse fallback) は **完全 bit-equal 維持** (北極星 3)
- UIA route 内 keyboardTypeBg recovery (line 198-215) は **完全 bit-equal 維持** (北極星 2)
- **mouse fallback text drop 防止 throw 文言更新** (Round 2 P2-5 反映、新 contract 意図的更新、3 case 個別更新):
  - `tests/unit/desktop-executor.test.ts:511` (`UIA-sourced + setValue with unsupportedExecutors:['uia']` case) expect 文字列に keyboard 含めた更新
  - `tests/unit/desktop-executor.test.ts:529` (`unsupportedExecutors:['mouse'] honoured` case) expect 文字列の `mouse fallback also blocked` 文言は維持 (mouseBlocked 経路、SR-5 で touch しない)
  - `tests/unit/desktop-executor.test.ts:561` (`terminal-sourced + type with unsupportedExecutors:['terminal']` case) expect 文字列に keyboard 含めた更新
  - 文言更新は src/tools/desktop-executor.ts mouse block text drop 防止 throw line 275-280 を `(uia=blocked/no-source, cdp=blocked/no-selector, terminal=blocked/no-source-or-text, keyboard=blocked/no-text-or-action) — ...` 等の形に拡張
- 新規 test:
  - `preferredExecutors=["keyboard"]` + text + setValue → keyboard direct, bare `"keyboard"` return
  - `preferredExecutors=["uia","keyboard"]` + UIA setValue succeeds → bare `"uia"` (registry が advertise する優先順位通り、内部 fallback 不発火)
  - `preferredExecutors=["uia","keyboard"]` + UIA setValue throws → UIA route 内 keyboardTypeBg recovery で bare `"keyboard"` (PR #330 contract、OQ-SR5-1 (1))
  - `preferredExecutors=["keyboard"]` + click action → keyboard block skip (text 必須)、CDP/terminal eligibility なし → mouse 直行 (北極星 9 (3) 整合)
- 既存 `desktop-executor.test.ts` 46 case + `desktop-executor-preferred-eligibility.test.ts` 10 case 全 green 維持 (本 PR で keyboard block 追加するが既存 case は preferredExecutors に "keyboard" を含まないため baseline 経路で完全同一動作)
- Phase 2 contract test 5 件全 green (`c-executor-downgrade.test.ts` 7 case + `e-uia-fallback-ladder.test.ts` 6 case + D/F/B)
- **CHANGELOG entry 必須** (CLAUDE.md 強制命令 10、§7 で文面起草)
- **dogfood 実機 smoke** (R-SR5-2-a 対策、PR-SR5-2 merge 前に user 確認)
- Opus phase-boundary review + Codex 1+ round (production code 改修、§3.3 Step 0)

### 5.5 risk

- **R-SR5-2-a**: 5 番目 keyboard block 追加で実環境 (production smoke / dogfood) で hardcoded ladder 時代と挙動差。**対策**: PR-SR5-2 merge 前に **dogfood 実機 smoke** を notification_show 後 user 確認 (CLAUDE.md ユーザー環境)、特に ValuePattern entity (Edit / ComboBox) で `preferredExecutors=["uia","keyboard"]` が advertised + UIA setValue throw → keyboardTypeBg recovery で bare "keyboard" return が正常動作するか
- **R-SR5-2-b**: text drop 防止 throw 文言更新で既存 test が breaking。**対策**: 文言更新は本 PR scope 内、`tests/unit/desktop-executor.test.ts` の text drop test の expect 文字列も同 commit で更新 (新 contract 意図的更新、R-SR5-1-b と同方針)
- **R-SR5-2-c** (Round 2 P2-4 反映、`executor_failed` 経路明示): keyboard block の throw 直伝播で「`preferredExecutors=["keyboard"]` + WT-XAML host で keyboardTypeBg fails」case の挙動。**確定**: 新 keyboard block で throw 直伝播 (try/catch なし) → guarded-touch (`src/engine/world-graph/guarded-touch.ts`) の最外周 catch → `ok: false, reason: "executor_failed"` を envelope に変換 → tool description `if_unexpected.try_next` (PR #329 contract) で `keyboard({...,method:"foreground"})` 等を suggest。**mouse rescue しない** (CDP/terminal と同 pattern、北極星 9 (3) 整合)。`preferredExecutors=["keyboard","mouse"]` 等の advertise が registry rule table で出るかは KeyboardWritable 単体判定 (OQ-SR5-2) 後に再考。text drop 防止 throw (mouse block line 275-280) は新 keyboard block で既に throw した path には到達しない (catch なし throw 直伝播のため)

### 5.6 Codex review prompt 雛形 (PR-SR5-2 用)

```
ADR-020 Phase 3 SR-5 PR-SR5-2 review:

【北極星 (SR-5 sub-plan §2): "keyboard" advertise + bare return 維持】
- 5 番目 keyboard block 追加が baseline 4 block の bit-equal 維持を破壊していないか
- UIA route 内 keyboardTypeBg recovery (line 198-215) が完全 bit-equal 維持か
- bare "keyboard" return 維持 (PR #330 contract、OQ-SR5-1 exit condition (1))

【AdvertisedExecutorKind 5 executor narrow】
- AdvertisedExecutorKind 拡張で TS compile-time guard が機能 (preferredExecutors 配列に "keyboard" 含む case が型 narrow 経由で routeable)
- ALLOWED_EXECUTORS Set 同期 (runtime defense-in-depth)

【副作用波 preventive sweep】
1. preferredAllows("keyboard") check が baseline 4 block 経路を破壊しない (entity.preferredExecutors === undefined / "keyboard" 含まない場合、keyboard block を必ず skip)
2. keyboard block の throw 直伝播 (mouse rescue しない、CDP/terminal と同 pattern)
3. text drop 防止 throw 文言更新で既存 test 整合性
4. ValuePattern entity に "keyboard" 共起 advertise した case (registry rule table 更新) で UIA setValue 優先順位維持

【API contract 真意 sweep】
- Phase 2 contract test C/E が 5 block 構造でも real production fallback path を invoke する設計保持
- PR #330 bare "keyboard" return contract 維持 (test 書換禁止部分の確認)
- PR #332 UIA→mouse downgrade marker 範囲外 (本 PR で touch しない)

【CHANGELOG】
- user-facing entry が CLAUDE.md 強制命令 10 準拠 (What changed / Why / How to use 三本柱)、内部 PR # / SR 番号 / reviewer round 番号等を含まない (P3-1 反映)

【§3.1 / §3.2 sweep (Round 2 P3-4 反映、Codex 補完軸 explicit 化)】
- §3.1 fact 整合: PR #330/#332/#296 既存 test 書換が「新 contract 意図的更新」と sub-plan §4.4 / §5.4 で明示記録されているか (`feedback_sonnet_test_executor.md` 例外として sub-plan SSOT に従う形)、Sonnet 単独 test 書換ではないか
- §3.2 carry-over scope shrink: `AdvertisedExecutorKind` 5 executor 拡張で既存 public API surface 不破壊か (EntityCapabilities shape / ExecutorKind / ExecutorOutcome / createDesktopExecutor signature / wire shape) — `UiEntity.preferredExecutors` engine field inline shape (`types.ts:148`) を AdvertisedExecutorKind 同期で 5 executor narrow に拡張する点を確認

P1/P2/P3 分類 + file:line citation 必須、報告 < 600 words。
```

---

## 6. acceptance (SR-5 epic 完了条件)

- PR-SR5-0 (sub-plan land) + PR-SR5-1 (registry + type 拡張) + PR-SR5-2 (executor 5 番目 block + CHANGELOG) 全 land + main HEAD で全 vitest + tsc clean
- `AdvertisedExecutorKind` 5 executor + `ALLOWED_EXECUTORS` Set 同期 (北極星 1)
- 5 block sequential 構造で baseline 4 block bit-equal + UIA route 内 keyboardTypeBg recovery bit-equal (北極星 2 + 3)
- 既存 public API 不破壊 (ExecutorKind / ExecutorOutcome / EntityCapabilities shape / createDesktopExecutor signature 全て backward compatible、北極星 4)
- CHANGELOG entry (CLAUDE.md 強制命令 10、北極星 5)
- OQ-SR5-1 exit condition (1) closure 明示 (北極星 6)
- Phase 2 contract test 5 件全 green 維持
- ADR-020 §11 carry-over ledger **L4 (E 軸)** strikethrough 化 (`[ ] L4 (E)` → `[x] L4 (E)` で構造除去達成 pin)

---

## 7. CHANGELOG entry 文案 (CLAUDE.md 強制命令 10 準拠)

```markdown
### Added

- **`keyboard` executor as a first-class advertised executor option** (Round 2 P3-1 反映で internal PR # 削除 + WT-XAML fail-soft 動作追記).
  When a text input exposes UIA `ValuePattern`, `entities[].capabilities.preferredExecutors` now lists `["uia", "keyboard"]` instead of `["uia"]`, so the LLM can opt to bypass UIA's name-filter requery and inject WM_CHAR directly via `keyboardTypeBg`. Useful for RichEdit / Document controls (e.g. Notepad's RichEditD2DPT) where UIA `setValue` fails because the entity's name/automationId cannot be re-found.

  The `keyboard` executor:
  - Sends WM_CHAR to the focused child of the target window (no focus-steal, same primitive as `terminal({action:'send'})`)
  - Returns `executor: "keyboard"` (bare string, no downgrade marker — internal UIA→keyboard recovery uses the same return shape, preserving the existing bare-string contract for the `desktop_act` text fallback)
  - **Fail-soft on unsupported windows**: Chromium / WT-XAML / UWP hosts surface `ok:false reason:"executor_failed"`, and the existing `desktop_act` `if_unexpected.try_next` recovery hint applies (typically suggesting `keyboard({action:'type', text, method:'foreground'})` which uses FG SendInput instead of background WM_CHAR injection)

  How to use: include `"keyboard"` in your tool call's intended executor preference, or rely on the `desktop_discover` advisory (`capabilities.preferredExecutors[1]` is now often `"keyboard"` for text inputs).
```

(Round 2 P3-1 + 強制命令 10 sweep: 「preserving the contract introduced in PR #330」→ 「preserving the existing bare-string contract for the `desktop_act` text fallback」と user-visible 表現に書換、内部 PR # 引用を削除。`grep "PR #"` で 0 件確認、`grep "SR-"` / `"north star"` / `"round"` も runtime 文字列に 0 件)

---

## 8. Risks (SR-5 全体)

| R# | risk | 対策 |
|----|------|------|
| R1 | `AdvertisedExecutorKind` 拡張で他 callsite (SR-1 で land 済 helper) が想定外動作 | `git grep AdvertisedExecutorKind` で全 callsite full read、PR-SR5-1 と PR-SR5-2 の依存順序遵守 (PR-SR5-1 land 前は registry rule table から "keyboard" emit されない) |
| R2 | 既存 test 書換が CLAUDE.md `feedback_sonnet_test_executor.md` 違反 risk | sub-plan で明示的に「PR-SR5-1/2 で land する新 contract に伴う意図的 test 更新」と記録、Sonnet 単独判断ではなく sub-plan SSOT に従う形 |
| R3 | 5 番目 keyboard block 追加で実環境挙動差 | PR-SR5-2 merge 前 dogfood 実機 smoke 必須 (R-SR5-2-a) |
| R4 | text drop 防止 throw 文言更新で既存 test breaking | 同 commit で test 文字列更新 (新 contract 意図的更新、R-SR5-2-b) |
| R5 | keyboard block throw 直伝播で WT-XAML host 失敗時の挙動が不明確 | §5.5 R-SR5-2-c で OQ-SR5-2 carry-over (KeyboardWritable 単体判定後に再考) |
| R6 | ValuePattern entity の `["uia","keyboard"]` advertise が過剰 (実際には keyboard 経由不要な entity に対しても advertise) | LLM 側は advisory として受け取り、UIA setValue 優先順位は維持されるため実害なし。dogfood smoke (R3) で observe |
| R7 | sub-plan 全文 re-read 漏れ (memory `feedback_sub_plan_full_reread.md` 4 連続再発 pattern) | 各 Round commit 前に sub-plan 全文 re-read + 修正対象 fact キーワード grep verify |
| R8 | KeyboardWritable 単体 case の判定が SR-5 で未実装 | OQ-SR5-2 で SR-5 完了後 dogfood 観察 → 必要なら別 epic / 後続 SR で対応 |

---

## 9. Open Questions

- **OQ-SR5-1**: 内部 UIA→keyboard recovery の marker emit (SR-1 sub-plan §9 で carry-over) → **本 SR-5 sub-plan §5.3 で (1) keep bare keyboard as final contract 確定**、Resolved
- **OQ-SR5-2** (Round 1 新規、Round 2 P3-2 反映で 2 軸 dependency 明示): `KeyboardWritable` 単体 entity (ValuePattern なし、controlType が `RichEdit`/`Document` 等 + KeyboardWritable check pass) の判定 + `preferredExecutors: ["keyboard"]` emit。SR-5 では保守的 scope で `ValuePattern` 検出のみで `"keyboard"` 共起 advertise、KeyboardWritable 単体判定は SR-5 完了後 dogfood 観察 → 必要なら別 epic / 後続 SR で対応。**2 軸 dependency** (Round 2 P3-2 反映):
  - **(a) UIA `IsKeyboardFocusable` API 連携 helper**: 現コードに **未実装** (`Grep IsKeyboardFocusable` 0 件確認)、UIA Rust addon (`src/uia/tree.rs`) 拡張 + napi binding 追加が新規必要
  - **(b) WM_CHAR injection 可能 hwnd 判定**: `src/engine/bg-input.ts:163-165` `canInjectAtTarget(hwnd)` 既存実装あり、流用可能
  - SR-5 で touch しない理由 = (a) が新規実装で本 SR-5 scope (~250-350 line + ~200-300 line = ~450-650 line) を超過、後続判断材料として永続化 (CLAUDE.md 強制命令 9 整合)
- **OQ-SR5-3** (Round 1 新規): 5 番目 keyboard block の throw 直伝播 vs mouse rescue 判断。本 SR-5 では「CDP/terminal と同 pattern で throw 直伝播」採用、`preferredExecutors=["keyboard","mouse"]` advertise が registry rule table で出るかは OQ-SR5-2 連動

---

## 10. Carry-over ledger sync (親 ADR §11)

SR-5 完了時 strikethrough:

- ADR-020 §11 **L4 (E)**: PR #330 `keyboardTypeBg` internal fallback ladder + `ExecutorKind: "keyboard"` (internal-only) → **SR-5 で構造除去** (`AdvertisedExecutorKind` 5 executor 拡張 + 5 番目 keyboard block 追加 + `["uia","keyboard"]` advertise で `"keyboard"` を first-class promote、internal-only 制約解消)

SR-5 は L4 のみ closure 対象 (L1 = B 軸 = SR-4 / L6 = G 軸 = SR-2 が別 SR スコープ、L2 = C 軸 = SR-1 で closure 済、L3/L5 = D/F = Phase 2 で closure 済)。

**親 ADR §11 への新 entry 追加なし** (SR-5 は KeyboardWritable 単体 OQ-SR5-2 を本 sub-plan §9 に保持、親 ADR L9 carry-over への昇格は SR-5 完了後 user 判断)。

---

## 11. 関連 SSOT / 参照先

- `docs/adr-020-path-class-refactor-plan.md` §5.1 SR-5 + §11 carry-over ledger L4
- `docs/adr-020-phase-3-sr-1-capability-registry-plan.md` §9 OQ-SR5-1 (本 SR-5 で closure)
- `src/engine/world-graph/types.ts:25-36` `ExecutorKind` JSDoc + 型定義 (`"keyboard"` 既に含む、SR-5 で JSDoc 文言更新)
- `src/capabilities/registry.ts:27-50` `AdvertisedExecutorKind` + `ALLOWED_EXECUTORS` (SR-5 で 4 → 5 executor 拡張)
- `src/capabilities/registry.ts:109-173` `lookupDefault` rule table (SR-5 で `hasValue` case 拡張)
- `src/capabilities/registry.ts:236-251` `ADVISORY_TEXT` (SR-5 で keyboard 言及追加)
- `src/tools/desktop-executor.ts:138-302` `createDesktopExecutor` (SR-5 で 5 番目 keyboard block 追加)
- `src/tools/desktop-executor.ts:198-215` UIA route 内 keyboardTypeBg recovery (SR-5 で bit-equal 維持)
- `tests/unit/desktop-executor.test.ts` 既存 46 case (SR-5 で text drop throw 文言 1 case 更新)
- `tests/unit/desktop-executor-preferred-eligibility.test.ts` 既存 10 case (PR-SR1-2 で land)
- `tests/unit/desktop-capabilities.test.ts` 既存 14 case (SR-5 で ValuePattern case 1 件更新)
- `tests/unit/capabilities-registry-invariant.test.ts` 既存 17 case (SR-5 で keyboard smuggle test 逆転 1 件更新)
- `tests/unit/desktop-register-tool-description.test.ts` snapshot (SR-5 で新 ADVISORY_TEXT pin)
- `tests/unit/path-class-contract/c-executor-downgrade.test.ts` Phase 2 C contract (SR-5 で touch しない)
- `tests/unit/path-class-contract/e-uia-fallback-ladder.test.ts` Phase 2 E contract (SR-5 で touch しない、bare "keyboard" return 強化 pin として温存)
- `CHANGELOG.md` (SR-5 で entry 追加)
- memory `feedback_opus_contract_truth_sweep.md` (PR-SR5-2 で contract test production-invoke 経路保全)
- memory `feedback_codex_side_effect_wave.md` (PR-SR5-2 副作用波 preventive sweep 必須)
- memory `feedback_sub_plan_full_reread.md` (各 Round commit 前 full re-read + grep verify)
- memory `feedback_auto_mode_merge_opus_judgment.md` (Opus + Codex 両 Approved で AI merge OK)
- CLAUDE.md §3.1 / §3.2 / §3.3 / 強制命令 7 / 強制命令 9 / **強制命令 10 (CHANGELOG 必須)**

---

## 12. 起草 metadata

- 起草日: 2026-05-17 (Round 1)
- 起草 session: ADR-020 SR-1 全 PR land 完了 (PR #339-#342) + user 指示「SR-5 着手」
- baseline commit: `2e79f4d` (main HEAD、PR-SR1-2 merge 後)
- Round 1 起草前 read 済:
  - `docs/adr-020-path-class-refactor-plan.md` §5.1 SR-5 + §11 L4
  - `docs/adr-020-phase-3-sr-1-capability-registry-plan.md` §9 OQ-SR5-1 (本 SR-5 で closure 対象)
  - `src/engine/world-graph/types.ts:25-58` ExecutorKind / ExecutorOutcome JSDoc + 型定義
  - `src/capabilities/registry.ts:22-50` AdvertisedExecutorKind + ALLOWED_EXECUTORS
- Round 1 主要 design 決定:
  - **OQ-SR5-1 exit condition (1) keep bare keyboard as final contract** 採用 (§5.3、根拠 4 件明示)
  - **保守的 scope**: `ValuePattern` 検出のみで `"keyboard"` 共起 advertise (`["uia","keyboard"]`)、`KeyboardWritable` 単体 case は OQ-SR5-2 で SR-5 完了後判断 (§9)
  - **2 PR 構成**: PR-SR5-1 (registry + type 拡張) → PR-SR5-2 (executor 5 番目 block + CHANGELOG) + PR-SR5-0 (sub-plan land)
  - **5 block sequential 構造**: UIA / CDP / terminal / **keyboard (新規、mouse 直前)** / mouse fallback、baseline 4 block は bit-equal 維持
- Round 1 OQ: OQ-SR5-1 closure (§5.3) + OQ-SR5-2 / OQ-SR5-3 新規 (§9)
- Round 2 反映点 (Opus R1 P1×2 + P2×6 + P3×4 + §3.2 sweep 発見 = 計 13 件):
  - **P1-1** (snapshot test 5 assertion 全件更新): §4.3 + §4.4 で snapshot regen + EXPECTED_ADVISORY + immutable + startsWith + endsWith の 5 assertion 全件更新を明示 (Lesson 4 numeric count sync、PR #342 Round 8 同型再発防止)
  - **P1-2** (§1.4 表「現状 emit」事実誤り): `hasInvoke` 優先順位を踏まえて表を 2 分岐 (`hasInvoke + ValuePattern 両持ち` = 現状 `["uia","mouse"]` SR-5 で touch しない / `hasValue` only = 現状 `["uia"]` SR-5 改修対象) に修正、`hasInvoke` ブランチを本 SR-5 で touch しない理由明示 (Phase 2 E contract test bit-equal 維持確保)
  - **§3.2 sweep 発見** (Opus 独自検出): `UiEntity.preferredExecutors` engine field inline shape (`types.ts:148`) は `AdvertisedExecutorKind` 拡張に自動追随しない → §3 PR-SR5-1 scope + §4.4 acceptance に追加更新明示 (Array<"uia"|"cdp"|"terminal"|"mouse"> → Array<"uia"|"cdp"|"terminal"|"mouse"|"keyboard">)
  - **P2-1** (numeric count drift risk): 実 case count 再 grep 確認 (`desktop-capabilities.test.ts` 14 case ✓ / `capabilities-registry-invariant.test.ts` 17 case ✓ Opus 「~18 case」は it.each 展開含む実 test count 把握誤り) + sub-plan の numeric 表記を SSOT (§11 関連 SSOT 表 + §4.4 acceptance) に集約
  - **P2-2** (ADVISORY_TEXT 内 SR 番号コメント明示): §4.3 snippet に「`──ADR-020 SR-5 で追加──` は TS コメントで runtime 文字列に含まれない、Sonnet 実装時に内部 SR 番号 / PR # 等を文字列内に埋め込まないこと」明示
  - **P2-3** (keyboard block 到達条件明示): §5.2 末尾に「新 keyboard block 到達条件」section 追加、典型 `preferredExecutors=["uia","keyboard"]` entity は UIA block 内 fallback で完結 (新 block 到達せず)、新 block 到達は `preferredExecutors=["keyboard"]` 単独 set 限定の限定 case のみ
  - **P2-4** (R-SR5-2-c throw 直伝播 → executor_failed 経路明示): §5.5 R-SR5-2-c に guarded-touch 最外周 catch → envelope 変換 → `if_unexpected.try_next` 経路明示、mouse rescue しない理由再確認
  - **P2-5** (text drop throw 全 case grep): `desktop-executor.test.ts:511 / 529 / 561` の 3 case を §5.4 acceptance に個別列挙、line 529 (mouseBlocked) は SR-5 で touch しない、line 511 / 561 を新 contract 意図的更新
  - **P2-6** (OQ-SR5-1 双方向リンク): §5.3 末尾に「SR-1 sub-plan §9 OQ-SR5-1 への closure pointer + SR-5 全 PR land 完了時の post-merge strikethrough」追加
  - **P3-1** (CHANGELOG WT-XAML fail-soft + PR # 削除): §7 文案修正 (内部 `PR #330` 引用を「existing bare-string contract」と user-visible 表現に書換 + WT-XAML fail-soft 動作 + `if_unexpected.try_next` 連動明記)
  - **P3-2** (OQ-SR5-2 2 軸 dependency 明示): §1.4 + §9 OQ-SR5-2 で「(a) UIA `IsKeyboardFocusable` API 連携 helper 未実装 + (b) `bg-input.ts::canInjectAtTarget` 既存」の 2 軸 dependency 明示、SR-5 で touch しない理由 (新規 helper 実装で scope 超過) 明記
  - **P3-3** (並走条件 1 行): §3 outline で「PR-SR5-2 は PR-SR5-1 land 後着手 (型依存)」明示、SR-1 と異なり並走不可
  - **P3-4** (Codex prompt §3.1 / §3.2 sweep 行追加): §5.6 雛形末尾に explicit 行追加
- Round 2 累積 closure: Round 1 (OQ-SR5-1/2/3 立案) + Round 2 (Opus R1 P1×2 + P2×6 + P3×4 + §3.2 sweep = 13 件) = **累積 13 件 closure**
- 次 step: 本 Round 2 反映後 → grep verify (主要 keyword bit-equal sync 確認) → Opus Round 2 re-review background trigger → P+P+P ゼロ確認 → user 諮問 → 承認後 PR-SR5-0 (sub-plan land) → PR-SR5-1 → PR-SR5-2 順次着手
