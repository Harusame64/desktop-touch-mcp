# Anti-Fukuwarai v2 — Batch H4 Visual Escalation / GPU Trigger 実装計画

作成: 2026-04-23
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`
入力: [`anti-fukuwarai-v2-h4-visual-escalation-instructions.md`](anti-fukuwarai-v2-h4-visual-escalation-instructions.md), [`anti-fukuwarai-v2-hardening-backlog.md`](anti-fukuwarai-v2-hardening-backlog.md), [`dogfood-incident-report.md`](dogfood-incident-report.md), [`anti-fukuwarai-v2-dogfood-log.md`](anti-fukuwarai-v2-dogfood-log.md)

---

## 0. 背景と目的

dogfood（S2 Outlook PWA / S5 Electron Codex）で `single-giant-pane` な target に対し、`desktop_see` が 0 entities を返し、visual lane が実質不発、最終的に OCR fallback + `mouse_click` に依存した。

このバッチは次を目指す。

1. `sparse UIA + CDP unavailable` な target で visual lane を以前より **早く候補** に上げる
2. visual lane が上がらなかった / 空だった場合の **理由（explainability）** を response から読める状態にする
3. OCR fallback に依存する前に visual lane を試させる（ただし full-frame OCR を primary に戻さない）

**再確認**: visual lane を常時 mandatory にしない。GPU path の全面 redesign はしない。V1 fallback は残す。warning / fail reason contract は壊さない。release / version bump / tag / publish はやらない。

---

## 1. 変更ファイル一覧

| ファイル | 変更概要 |
|---|---|
| `src/tools/desktop-providers/uia-provider.ts` | `detectUiaBlind()` の結果を warning (`uia_blind_single_pane` / `uia_blind_too_few_elements`) として出力。既存の `uia_no_elements` も維持 |
| `src/tools/desktop-providers/compose-providers.ts` | `view=debug` と UIA-blind 兆候を visual escalation 条件に追加。visual lane 未発動理由を `warnings` に追加（`visual_not_attempted` / `visual_attempted_empty`）。`ComposeOptions` を新設し `view` を受け取る |
| `src/tools/desktop.ts` | `ingress.getSnapshot(key)` と `composeCandidates()` に `view` を渡すため、`ComposeOptions`-aware な ingress fetch を用意 |
| `src/tools/desktop-register.ts` | ingress の fetchFn に `view` を引き回す仕組み（ingress は target key 単位でキャッシュするので、`view` は ingress の手前で反映 or fetch 側で反映する設計にする） |
| `tests/unit/desktop-providers.test.ts` | UIA-blind warning の単体テスト追加 |
| `tests/unit/desktop-providers-active-target.test.ts` | `view=debug` と UIA-blind が visual を昇格させるテスト追加。未発動理由 warning の assertion 追加 |
| `tests/unit/desktop-facade.test.ts` | `view=debug` 時に visual 試行が warning に反映される回帰テスト追加 |

最小変更: `visual-provider.ts` / `browser-provider.ts` / `types.ts` / `candidate-ingress.ts` は触らない。`detectUiaBlind()` は既存を再利用する。

---

## 2. Visual escalation 条件の設計

### 2.1. 現状（ベースライン）

`compose-providers.ts` は **target type** だけで lane を決めている。

- `tabId` あり: browser + visual (additive)
- terminal title: terminal + uia + visual (additive)
- それ以外（native window）: uia + visual (additive)

つまり visual lane は **常に additive で呼ばれているが、`visual_provider_unavailable` / `visual_provider_warming` で実質不発** になるケースが多い。B batch の 200 ms retry が入っているが、retry 後に warm でも GPU backend がその target に関する stable candidate を持っていないと empty になる。

### 2.2. 今回の昇格判断軸

visual lane を「常時試す」ではなく、「UIA が blind だと推定される target」かつ「structured lane が vicinity に無い」場合に、visual lane を **明示的に試行済みとして扱う** + **未発動理由を警告として返す**。

判断に使うシグナルは次の 4 つに絞る（過剰モデリングを避ける）。

| シグナル | 取得元 | 意味 |
|---|---|---|
| `uiaBlind` | `detectUiaBlind(UiElementsResult)` | UIA tree が sparse。`single-giant-pane` / `too-few-elements` を区別できる |
| `cdpAvailable` | `isBrowserTarget(target)` が true で browser provider が candidate を出したか | CDP lane が機能したかどうか |
| `requestedDebug` | `input.view === "debug"` | operator が明示的に debug を求めている |
| `visualState` | visual provider の return warnings を見て判定 | `visual_provider_unavailable` / `visual_provider_warming` / 空だが warning なし = attempted-but-empty / warning なし + candidate あり |

### 2.3. 昇格ルール

**Rule-A: UIA blind + non-browser target で visual lane を "escalated" とマークする**
- uia provider が `uia_blind_single_pane` または `uia_blind_too_few_elements` を返した native target では、visual lane が attempted-but-empty でも必ず理由を 1 つ warning に乗せる
- これまで通り visual lane は呼ばれている。変えるのは「**呼ばれたが empty だったときの見せ方**」

**Rule-B: `view=debug` のとき、visual lane を "forced-try" として扱う**
- `view=debug` + visual が空 → `visual_attempted_empty_in_debug` を warning に追加
- `view=debug` + visual が unavailable → 既存の `visual_provider_unavailable` に加えて `visual_not_attempted` を warning に追加

**Rule-C: browser target で CDP 失敗 + visual 空のとき、hint を乗せる**
- browser path で `cdp_provider_failed` が出た上で visual も empty なら、`visual_attempted_empty_cdp_fallback` を warning に追加

**Rule-D: visual lane を常時 mandatory にはしない**
- 既存の `composeCandidates()` は visual を `Promise.allSettled` で並列実行しているため、追加の呼び出しは発生させない
- 今回の変更は「visual の呼び出し頻度を増やす」のではなく、「**既存の呼び出し結果を debug / blind シグナルで意味付けする**」

### 2.4. 具体的な判定フロー（疑似コード）

```ts
// compose-providers.ts 内
const uiaBlindWarning = result.warnings.find((w) =>
  w === "uia_blind_single_pane" || w === "uia_blind_too_few_elements"
);
const hasVisualWarning = visualResult.warnings.some((w) =>
  w === "visual_provider_unavailable" || w === "visual_provider_warming"
);
const visualEmpty = visualResult.candidates.length === 0;
const escalate = Boolean(uiaBlindWarning) || options?.view === "debug";

const escalationWarnings: string[] = [];
if (escalate && hasVisualWarning) {
  escalationWarnings.push("visual_not_attempted");
}
if (escalate && !hasVisualWarning && visualEmpty) {
  escalationWarnings.push("visual_attempted_empty");
}
```

---

## 3. Visual 未発動理由の見せ方

### 3.1. 新規 warning コード（契約追加）

既存 enum は壊さず、**additive** で次を追加する。docs (`candidate-ingress.ts` の JSDoc) も最小更新する。

| warning code | 意味 | 発火条件 |
|---|---|---|
| `uia_blind_single_pane` | UIA tree が 1 枚の巨大 Pane に閉じている（PWA / Electron 典型） | `detectUiaBlind().reason === "single-giant-pane"` |
| `uia_blind_too_few_elements` | UIA element 数が閾値未満 | `detectUiaBlind().reason === "too-few-elements"` |
| `visual_not_attempted` | visual lane を呼んだが backend が unavailable / warming で候補生成に至らず | `escalate && (visual_provider_unavailable / visual_provider_warming が残った)` |
| `visual_attempted_empty` | visual lane は warm だったが、この target に stable candidate が無かった | `escalate && 上記の warning なし && visual candidates が 0` |

### 3.2. 既存 warning との関係

- 既存の `visual_provider_unavailable` / `visual_provider_warming` は **そのまま残す**（B batch retry の契約を壊さない）
- 今回追加の `visual_not_attempted` は、retry しても still unavailable な場合に「operator が GPU / backend 接続を確認するヒント」として被さる形にする
- `uia_no_elements` と `uia_blind_*` は **両方出る可能性がある**（candidate が 0 件でかつ blind 判定された場合）

### 3.3. desktop_see response への伝搬

- `DesktopSeeOutput.warnings?` に既に warning array が積まれているので、追加 warning は自動的に response に載る（`desktop.ts` の `if (rawResult.warnings.length > 0) output.warnings = rawResult.warnings;` 経由）
- schema 変更は不要。新規 warning は文字列として追加されるだけ

### 3.4. `desktop_see` tool description の最小更新

`desktop-register.ts` の description に、新 warning の recovery hint を 1 行追加する。

```
uia_blind_single_pane / uia_blind_too_few_elements → target is PWA/Electron/canvas; try view=debug or visual lane / OCR fallback;
visual_not_attempted → GPU backend is unavailable; fallback to V1 screenshot(ocrFallback=always);
visual_attempted_empty → visual lane ran but produced no stable candidates; consider OCR fallback or V1 tools;
```

---

## 4. ingress / view 伝播の設計メモ

### 4.1. 現状

`desktop-register.ts` の `SnapshotIngress` は fetchFn を `(key: string) => composeCandidates(targetKeyToSpec(key))` として受け取っている。`view` は ingress の key に入っていない。

### 4.2. 今回の扱い

- **ingress をまたぐ汎用伝播はやらない**。ingress のキャッシュキーを変えると後続バッチに影響するため、今回は **`desktop.ts` 側でパイプを分岐** する
- `desktop.ts` の `see()` は現状 `ingress.getSnapshot(key)` か `candidateProvider(input)` のどちらかを呼ぶ。今回は **`view === "debug"` の場合のみ ingress をバイパスして `candidateProvider(input)` を呼ぶ**、あるいは **ingress の result + view を使って post-process warning を追加する** のいずれか
- 採用案: **後者（ingress の result を post-process で warning enrich する）**
  - ingress による cache ヒットを壊さない
  - compose-providers の escalation ロジックは `composeCandidates(target, options)` 内に閉じるのではなく、`composeCandidates()` はそのままにして、`desktop.ts` が result.warnings を見て `view=debug` 時の追加警告を足す
  - ただし `uia_blind_*` は provider 側でないと計算できないので provider 側で出す

### 4.3. 責務分担（決定）

- **`uia-provider.ts`**: `uia_blind_single_pane` / `uia_blind_too_few_elements` を出す
- **`compose-providers.ts`**: UIA-blind warning が provider result に入っていれば、visual 側の状態を見て `visual_not_attempted` / `visual_attempted_empty` を合成する（= Rule-A / Rule-C の escalation ロジック）
- **`desktop.ts`**: `view === "debug"` のとき、`visual_not_attempted` / `visual_attempted_empty_in_debug` を追加する post-process を書く（= Rule-B）
  - ingress の cache に compose 側の warning が残っているため、desktop.ts 側で view-aware に**さらに warning を足す**
  - ただし過剰重複を避けるため、既に compose 側が `visual_not_attempted` を入れていたら `_in_debug` サフィックスは付けず skip

### 4.4. 例: single-giant-pane + no CDP の PWA（S2 再現）

1. uia-provider が `uia_blind_single_pane` を warning に載せ、0 candidates を返す（`uia_no_elements` も併発）
2. visual-provider が `visual_provider_unavailable` を返す（backend 未 warm）
3. B batch の retry が走るが still unavailable
4. compose-providers が escalate 判定: `uiaBlind=true` + visual warn → `visual_not_attempted` を合成
5. desktop.ts は view="action" なら追加なし、view="debug" なら既に `visual_not_attempted` があるので `_in_debug` は付けない
6. `desktop_see` response の `warnings = ["uia_blind_single_pane", "uia_no_elements", "visual_provider_unavailable", "visual_not_attempted"]`

これで LLM / operator は「UIA も CDP も効かず、GPU backend も上がっていない」ことが 1 目で分かる。

---

## 5. 追加/更新するテストケース

### 5.1. `tests/unit/desktop-providers.test.ts`（UIA provider 側）

新規 block: `fetchUiaCandidates — UIA-blind warnings (H4)`

```ts
it("emits uia_blind_single_pane when single giant pane dominates window", async () => {
  // Arrange: mock getUiElements to return a result that detectUiaBlind() classifies as single-giant-pane
  // 具体的には getUiElements を vi.mock で差し替え、elements に 1 つの巨大 Pane と windowRect を与える
  // Act
  const r = await fetchUiaCandidates({ windowTitle: "Outlook PWA" });
  // Assert
  expect(r.warnings).toContain("uia_blind_single_pane");
});

it("emits uia_blind_too_few_elements when element count < 5", async () => {
  // mock: elementCount = 2
  const r = await fetchUiaCandidates({ windowTitle: "Codex" });
  expect(r.warnings).toContain("uia_blind_too_few_elements");
});

it("does NOT emit uia_blind_* when tree is healthy", async () => {
  // mock: 20 elements, no giant pane
  const r = await fetchUiaCandidates({ windowTitle: "Notepad" });
  expect(r.warnings).not.toContain("uia_blind_single_pane");
  expect(r.warnings).not.toContain("uia_blind_too_few_elements");
});
```

### 5.2. `tests/unit/desktop-providers-active-target.test.ts`（compose 側）

既存 mock 構造を活用して追加。

```ts
it("escalates visual_not_attempted when uia is blind and visual is unavailable", async () => {
  mocks.fetchUiaCandidates.mockResolvedValue({
    candidates: [],
    warnings: ["uia_blind_single_pane", "uia_no_elements"],
  });
  mocks.fetchVisualCandidates.mockResolvedValue({
    candidates: [],
    warnings: ["visual_provider_unavailable"],
  });
  const result = await composeCandidates({ hwnd: "999" });
  expect(result.warnings).toContain("uia_blind_single_pane");
  expect(result.warnings).toContain("visual_provider_unavailable");
  expect(result.warnings).toContain("visual_not_attempted");
});

it("escalates visual_attempted_empty when uia blind and visual warm-but-empty", async () => {
  mocks.fetchUiaCandidates.mockResolvedValue({
    candidates: [],
    warnings: ["uia_blind_single_pane"],
  });
  mocks.fetchVisualCandidates.mockResolvedValue({
    candidates: [],
    warnings: [], // warm, no warning, just empty
  });
  const result = await composeCandidates({ hwnd: "999" });
  expect(result.warnings).toContain("visual_attempted_empty");
});

it("does NOT escalate when uia tree is healthy", async () => {
  mocks.fetchUiaCandidates.mockResolvedValue({
    candidates: [candidate("Save", "uia", "123")],
    warnings: [],
  });
  mocks.fetchVisualCandidates.mockResolvedValue({ candidates: [], warnings: [] });
  const result = await composeCandidates({ hwnd: "123" });
  expect(result.warnings).not.toContain("visual_not_attempted");
  expect(result.warnings).not.toContain("visual_attempted_empty");
});

it("browser target with cdp_provider_failed + empty visual → visual_attempted_empty_cdp_fallback", async () => {
  mocks.fetchBrowserCandidates.mockResolvedValue({
    candidates: [],
    warnings: ["cdp_provider_failed"],
  });
  mocks.fetchVisualCandidates.mockResolvedValue({ candidates: [], warnings: [] });
  const result = await composeCandidates({ tabId: "tab-1" });
  expect(result.warnings).toContain("visual_attempted_empty_cdp_fallback");
});
```

### 5.3. `tests/unit/desktop-facade.test.ts`（view=debug 側）

既存 describe `DesktopFacade — desktop_see` の末尾に追加。

```ts
describe("DesktopFacade — H4 visual escalation in view=debug", () => {
  it("view=debug surfaces visual_not_attempted when provider warnings say unavailable", async () => {
    // CandidateProvider mock を使う既存スタイルに合わせる。ingress を使わないルートで十分。
    // facade は ingress 未指定だと candidateProvider を直接呼び、warnings は空として扱う。
    // そのため compose-providers 経由のテストは 5.2 で担保し、ここでは
    // desktop.ts が ingress の warnings に post-process で visual_not_attempted を
    // 注入するルートを検証する必要がある。
    //
    // 実装は facade のオプションで ingress を差し込むパターン:
    const fakeIngress: CandidateIngress = {
      getSnapshot: async () => ({
        candidates: [],
        warnings: ["uia_blind_single_pane", "visual_provider_unavailable"],
      }),
      invalidate: () => {},
      subscribe: () => () => {},
      dispose: () => {},
    };
    const facade = new DesktopFacade(() => [], { ingress: fakeIngress });
    const out = await facade.see({ view: "debug" });
    // compose 側が既に visual_not_attempted を入れているか、desktop.ts が view=debug で入れるか
    // どちらでも OK
    expect(out.warnings).toContain("visual_not_attempted");
  });
});
```

### 5.4. `tests/unit/desktop-register.test.ts`

description snapshot の `expectedFragments` に新 warning 名を追加する最小修正（ただし文字列差分に留める）。

```ts
const expectedFragments = [
  "[EXPERIMENTAL]",
  "warnings[]",
  "no_provider_matched",
  "cdp_provider_failed",
  "visual_provider_unavailable",
  "uia_blind_single_pane",    // H4
  "visual_not_attempted",     // H4
] as const;
expect(expectedFragments).toHaveLength(7);
```

---

## 6. 実装手順（Sonnet が実装できる精度で）

### Step 1: `uia-provider.ts` に UIA-blind warning を追加

```ts
// src/tools/desktop-providers/uia-provider.ts の fetchUiaCandidates()

import { getUiElements, detectUiaBlind } from "../../engine/uia-bridge.js"; // detectUiaBlind を追加 import

// ... 既存コード ...

try {
  const { getUiElements, detectUiaBlind } = await import("../../engine/uia-bridge.js");

  const options = target.hwnd ? { hwnd: BigInt(target.hwnd) } : undefined;
  const result  = await getUiElements(windowTitle, 4, 80, 8000, options);

  const candidates: UiEntityCandidate[] = result.elements
    .filter((el) => el.isEnabled && el.name)
    .map((el): UiEntityCandidate => ({ /* ... 既存通り ... */ }));

  const warnings: string[] = [];
  if (candidates.length === 0) warnings.push("uia_no_elements");

  // H4: UIA-blind detection
  const blind = detectUiaBlind(result);
  if (blind.blind) {
    if (blind.reason === "single-giant-pane") warnings.push("uia_blind_single_pane");
    else if (blind.reason === "too-few-elements") warnings.push("uia_blind_too_few_elements");
  }

  return { candidates, warnings };
} catch (err) {
  console.error(`[uia-provider] Error for target "${targetId}":`, err);
  return { candidates: [], warnings: ["uia_provider_failed"] };
}
```

**注意**: JSDoc コメント冒頭の warning enum 列挙にも `uia_blind_single_pane` / `uia_blind_too_few_elements` を追加する。

### Step 2: `compose-providers.ts` に escalation ロジックを追加

```ts
// src/tools/desktop-providers/compose-providers.ts

// ── H4: visual escalation helpers ─────────────────────────────────────────────
const UIA_BLIND_WARNINGS = new Set(["uia_blind_single_pane", "uia_blind_too_few_elements"]);
const VISUAL_UNREADY_WARNINGS = new Set([
  "visual_provider_unavailable",
  "visual_provider_warming",
]);

function applyVisualEscalation(
  primaryResult: ProviderResult,
  visualResult: ProviderResult,
  primaryKind: "uia" | "browser" | "terminal"
): string[] {
  const extra: string[] = [];
  const uiaBlind = primaryResult.warnings.some((w) => UIA_BLIND_WARNINGS.has(w));
  const cdpFailed = primaryResult.warnings.includes("cdp_provider_failed");
  const visualUnready = visualResult.warnings.some((w) => VISUAL_UNREADY_WARNINGS.has(w));
  const visualEmpty = visualResult.candidates.length === 0;

  // Rule-A: uia blind + visual unready → visual_not_attempted
  if (primaryKind === "uia" && uiaBlind && visualUnready) {
    extra.push("visual_not_attempted");
  }
  // Rule-A': uia blind + visual warm-but-empty → visual_attempted_empty
  if (primaryKind === "uia" && uiaBlind && !visualUnready && visualEmpty) {
    extra.push("visual_attempted_empty");
  }
  // Rule-C: browser cdp failed + empty visual
  if (primaryKind === "browser" && cdpFailed && visualEmpty) {
    extra.push("visual_attempted_empty_cdp_fallback");
  }
  return extra;
}
```

その上で native window 分岐 / browser 分岐を書き換える。

```ts
// Native window path
const escalation = applyVisualEscalation(uiaResult, visualResult, "uia");
const merged = mergeResults([uiaResult, visualResult]);
const mergedWithEscalation = escalation.length > 0
  ? { ...merged, warnings: dedupeWarnings([...merged.warnings, ...escalation]) }
  : merged;
return withPrependedWarnings(
  addWarningIfPartial(mergedWithEscalation, uiaResult.candidates.length),
  normalized.warnings
);
```

`dedupeWarnings()` は `mergeResults()` の中の順序保存 dedupe ロジックを小関数に切り出して再利用すればよい（2 行程度）。

browser path / terminal path も同様に `applyVisualEscalation(primaryResult, visualResult, "browser" | "terminal")` を呼び warning を合成する。terminal path は Rule-A を流用（uia lane が primary ではないので `primaryKind="terminal"` で basically noop、ただし uia の warning を見て同等判定を入れてよいが **今回は uia lane primary のケースだけに絞る**）。

### Step 3: `desktop.ts` に `view=debug` 時の追加 post-process

```ts
// src/tools/desktop.ts の see() 内、rawResult を得た直後

const rawResult = this.opts.ingress
  ? await this.opts.ingress.getSnapshot(key)
  : { candidates: await Promise.resolve(this.candidateProvider(input)), warnings: [] as string[] };

// H4: view=debug で visual unready が残っていれば visual_not_attempted を足す（compose 側で既に入っていれば skip）
if (input.view === "debug") {
  const hasVisualUnready = rawResult.warnings.some(
    (w) => w === "visual_provider_unavailable" || w === "visual_provider_warming"
  );
  const hasEscalated = rawResult.warnings.includes("visual_not_attempted");
  if (hasVisualUnready && !hasEscalated) {
    rawResult.warnings = [...rawResult.warnings, "visual_not_attempted"];
  }
}
```

**理由**: compose-providers は uia-blind が無いと escalate しない。`view=debug` は operator 明示なので、uia tree が見かけ上 healthy でも visual backend 不調を可視化したい。

### Step 4: `desktop-register.ts` の tool description を更新

```ts
server.tool(
  "desktop_see",
  [
    // ... 既存 ...
    "uia_blind_single_pane / uia_blind_too_few_elements → target is PWA/Electron/canvas;",
    "  try view=debug for visual lane hints, or fall back to screenshot(ocrFallback=always);",
    "visual_not_attempted → GPU backend unavailable; use V1 screenshot + mouse_click or wait and retry;",
    "visual_attempted_empty → visual lane ran but produced no stable candidates; use OCR fallback.",
  ].join(" "),
  // ...
);
```

### Step 5: `candidate-ingress.ts` の JSDoc warning 列挙を更新（コメントのみ）

`ProviderResult` 上のコメントで warning 一覧を補強。挙動変更なし。

```ts
/**
 * Warning codes are stable machine-readable strings (not prose):
 *   ...既存...
 *   uia_blind_single_pane     — (H4) UIA tree is a single giant Pane (PWA/Electron/canvas)
 *   uia_blind_too_few_elements — (H4) UIA tree element count below threshold
 *   visual_not_attempted       — (H4) visual lane call did not complete (unavailable/warming)
 *   visual_attempted_empty     — (H4) visual lane ran but produced no candidates
 *   visual_attempted_empty_cdp_fallback — (H4) CDP failed and visual also empty (browser)
 */
```

### Step 6: テスト実装 & 回帰確認

```bash
npm run build
npx vitest run tests/unit/desktop-providers.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-register.test.ts tests/unit/desktop-providers-active-target.test.ts
```

必要なら `uia-bridge` の `detectUiaBlind` に対する単体テストも念のため追加する（既に `screenshot.ts` 経由で間接テストはあるが、直テストは今回追加して損はない）。

---

## 7. 注意事項・落とし穴

1. **visual-provider.ts を変えない**
   visual の attach/warm retry ロジックは B batch で安定化済み。ここに手を入れると retry の回帰を招く。今回は「visual result を compose 側でどう解釈するか」に留める。

2. **ingress キャッシュを view で分割しない**
   ingress の cache key は `window:hwnd` / `tab:id` / `title:...` の 3 種のまま。`view` を混ぜると cache が fragment して idle cost が増える。view-aware な調整は `desktop.ts` の post-process に寄せる（Step 3）。

3. **`detectUiaBlind` の閾値は変えない**
   既に `UIA_BLIND_MIN_ELEMENTS=5` / `UIA_BLIND_PANE_AREA_RATIO=0.9` が既存 logic として `screenshot.ts` の SoM mode で使われている。ここを触ると SoM pipeline の挙動も変わる。

4. **Rule-C (browser + cdp fail + visual empty) は敢えて弱めに**
   CDP 接続は user environment 依存で failure がノイズになりやすい。今回は `cdp_provider_failed` が明示的に出たときだけ warning を足す。`cdp_no_elements` では足さない（CDP は reachable だがページに要素が無いだけ）。

5. **既存の `partial_results_only` と重なる可能性**
   `addWarningIfPartial()` は primary 0 件 + fallback が candidate を出した場合に付く。今回の `visual_attempted_empty` は visual が 0 件のケースなので、両方は同時には出ない（mutually exclusive）。重複出力にならないことをテストで担保する。

6. **warning 順序の安定性**
   既存テストで `result.warnings[0]` を見ているものがある（active-target test の prepend 順序検査）。今回追加する warning は末尾に足すので、`warnings[0]` を見る assertion は壊れない。

7. **`uia_blind_single_pane` と `uia_no_elements` の併発**
   巨大 Pane 1 枚 + actionable 0 件のケースは両方出る。これは **意図通り**。LLM は 2 つ見れば「UIA が実質 blind」と推測しやすくなる。

8. **terminal path では escalate しない**
   terminal lane が primary のとき、UIA blind は起こりうるが terminal provider が buffer を読めていれば問題ない。terminal primary では `applyVisualEscalation(..., "terminal")` は noop を返す（Rule-A/B/C どれにも該当しない）。

9. **desktop_see schema は変更なし**
   新 warning は既存の `warnings?: string[]` に乗るだけ。Zod schema は touらない。

10. **view=debug で ingress を通るか**
    `desktop.ts` は ingress がある限り ingress を優先する。view=debug のときに ingress をバイパスするかどうかは別議論（H2 / H3 に近い）。今回は **ingress を使ったまま、post-process で warning を enrich** する設計。

---

## 8. 避けるべきこと（再確認）

- visual lane を **常時 mandatory** にする（今回は呼び出し頻度を増やさない）
- **OCR fallback を primary path に戻す**（OCR は V1 fallback のまま）
- **GPU path の全面 redesign**（visual-provider.ts は無修正）
- **visual の call 回数を増やす**（`fetchVisualCandidatesWithRetry` の挙動は B batch のまま）
- **negative capability の全面モデリング**（H2 の範囲）
- **common dialog / window hierarchy 修正**（H3 の範囲）
- **ingress キャッシュキーに view を混ぜる**（cache fragmentation のリスク）
- **既存 warning enum を rename / 削除**（14 コード契約を維持）
- **release / version bump / tag / publish**（Go 後の hardening スコープ外）
- **V1 fallback の撤去**
- **Zod schema / response shape の breaking change**

---

## 9. 完了条件

1. `single-giant-pane + no CDP` の mock target で `desktop_see` response の `warnings` に `uia_blind_single_pane` と `visual_not_attempted` が両方出る
2. structured lane が十分 healthy なケースでは `visual_not_attempted` / `visual_attempted_empty` は出ない
3. `view=debug` 時に visual unready であれば `visual_not_attempted` が出る
4. 既存 B batch の `visual_provider_unavailable` / `visual_provider_warming` 契約を壊していない
5. `npm run build` と関連 unit tests（desktop-providers / desktop-facade / desktop-register / desktop-providers-active-target）が全通
6. `desktop_see` tool description の recovery hint が新 warning を含む

---

## 10. docs 更新（最小）

実装後に必要最小限で touch:

- `docs/anti-fukuwarai-v2-hardening-backlog.md` — H4 欄に "done" 状況メモ
- `docs/anti-fukuwarai-v2-default-on-readiness.md` — warning 列挙に新規 4 コード追記
- `docs/anti-fukuwarai-v2-dogfood-log.md` — S2 / S5 の「今後の改善候補」欄に H4 実装済み行を追記（optional）

---

## 11. 推奨 commit

```text
feat(providers): escalate visual lane earlier for sparse-uia no-cdp targets
```

補足: 1 commit でよい。testファイル変更と provider / facade 変更を同じ commit にまとめる。
