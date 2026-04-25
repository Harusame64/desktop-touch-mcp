# CDP Search Plan — `browser_search`

> 2026-04-13 — Plan for letting LLMs efficiently grep Chrome DOM over CDP
> Sibling plan: [`terminal-integration-plan.md`](./terminal-integration-plan.md)
> Parent context: [`anti-fukuwarai-ideals-plan.md`](./anti-fukuwarai-ideals-plan.md)

## Progress

| Step | Status | Commit |
|---|---|---|
| B-1 `browser_search` handler (text/regex/role/ariaLabel/selector; 3s in-loop budget; confidence rank) | ✅ Done | `f79f6e7` `c147234` |
| B-2 TOOL_REGISTRY 登録 | ✅ Done | `f79f6e7` |
| ideals-plan X-2 反映 (`wait_until(element_matches)`) | ✅ Done | `f79f6e7` |
| ideals-plan X-3 反映 (Phase 2.1 post narration 除外に browser_search 追加) | ✅ Done | `f79f6e7` |
| ideals-plan X-4 反映 (suggest 辞書追加 2 エントリ) | ✅ Done | `f79f6e7` |

---

## Context

Chrome を CDP（debug mode）で操作する際、要素検索の粒度が粗い：

- `browser_find_element` / `browser_click_element` は **CSS セレクタ専用**
- `browser_get_interactive` は type (link/button/input/all) と scope フィルタのみ、text / regex / role / aria-label 検索は不可
- 「ページ上の "New issue" という文言を含むボタン」「全 input の name 一覧」を取るには毎回 `browser_eval` で生 JS を書く運用

これは LLM からすると「Grep に相当するツールがない」状態。本プランで `browser_search` 1 本に集約する。

---

## Guiding Principle

> **検索軸（by）ごとに response 形状を変えず、confidence で優先度を明示する。**
> LLM は results を confidence 順に受け取り、最有力候補を決め打ちで次 action に進める。

---

## B-1. `browser_search`

### Signature
```ts
browser_search({
  port?: number, tabId?: string,
  by: "text" | "regex" | "role" | "ariaLabel" | "selector",
  pattern: string,
  scope?: string,                   // CSS で検索範囲を限定
  maxResults?: number = 50,
  offset?: number = 0,
  visibleOnly?: boolean = true,
  inViewportOnly?: boolean = false,
  caseSensitive?: boolean = false   // by:"text"|"regex" で効く
}) → ok({
  total: number,                    // offset 適用前のヒット総数
  returned: number,
  truncated: boolean,
  results: Array<{
    type: "link"|"button"|"input"|"heading"|"text"|"other",
    text: string,                   // 最大 80 字切詰
    selector: string,               // bestSelector() 由来、後続の browser_click_element で使える
    role?: string,
    ariaLabel?: string,
    matchedBy: "text"|"regex"|"role"|"ariaLabel"|"selector",
    confidence: number,             // 0-1、Phase 2.3/3.3 と同軸
    inViewport: boolean,
    rect?: { x: number, y: number, w: number, h: number }
  }>,
  hints: { chromiumTab, scopeResolved, searchScript: "inline" }
}) | fail({ code, suggest, context })
```

### confidence 合成規則（Phase 3.3 UIA synthetic confidence と同軸）
| マッチ条件 | confidence |
|---|---|
| `by:"selector"` 完全一致 | 1.00 |
| `by:"text"` 完全一致 かつ visible | 1.00 |
| `by:"ariaLabel"` 完全一致 | 0.95 |
| `by:"regex"` マッチ | 0.90 |
| `by:"text"` 部分一致 | 0.80 |
| `by:"role"` マッチ | 0.75 |
| visible=false の場合 | 上記から 0.30 減点 |

results は **confidence 降順**で返す。LLM は `results[0]` を信頼して次 action に進める運用。

### 実装ポイント
- `src/tools/browser.ts` に handler 追加（新規ファイル不要、既存 `browser_get_interactive` と同じ IIFE パターン）
- `Runtime.evaluate` で `document.querySelectorAll('*')` を走査し JS 側で by に応じた絞込み
- `bestSelector()` (browser.ts:484-517) 再利用
- visibility 判定は `browser_get_interactive` と同じロジック (`getComputedStyle` + `getBoundingClientRect`)
- Accessibility Domain (`Accessibility.getFullAXTree`) は v1 では使わない — DOM 走査で十分
- scope 指定時は scope querySelector が失敗したら `fail({code:"ScopeNotFound", suggest:["Check scope selector", "Omit scope to search whole doc"]})`

### エラーパス
| 条件 | code | suggest |
|---|---|---|
| ヒットなし | `BrowserSearchNoResults` | `["Try different 'by' axis", "Remove scope", "Set visibleOnly:false / includeHidden:true"]` |
| Runtime.evaluate タイムアウト | `BrowserSearchTimeout` | `["Reduce maxResults", "Narrow scope via CSS selector"]` |
| scope セレクタが見つからない | `ScopeNotFound` | `["Check scope selector syntax", "Omit scope"]` |
| CDP 未接続 | `BrowserNotConnected` | `["Call browser_connect first"]` |

---

## B-2. `run_macro` 登録

`src/tools/macro.ts:35-59` TOOL_REGISTRY に `browser_search` を追加。

これで以下マクロが 1 call で書ける：
```json
{
  "steps": [
    {"tool": "browser_navigate", "args": {"url": "https://github.com/owner/repo/issues"}},
    {"tool": "wait_until", "args": {"condition": "element_matches", "target": {"by": "text", "pattern": "New issue"}, "timeoutMs": 5000}},
    {"tool": "browser_search", "args": {"by": "text", "pattern": "New issue"}},
    {"tool": "browser_click_element", "args": {"selector": "<result[0].selector>"}}
  ]
}
```

---

## Phase 3.1.c `get_document_state` との責務分離

| ツール | 守備範囲 | 典型用途 |
|---|---|---|
| `get_document_state` | ページ粗粒度（url, title, readyState, selection, scroll） | "どのページに居るか" の再確認 |
| `browser_search` | ページ内要素の詳細検索 | "目的の要素" の特定 |

重複なし。LLM の用途も明確に分岐する。

---

## ideals-plan との連動項目

### X-2. `wait_until` condition 拡張（ideals-plan Phase 1.3）
```ts
wait_until({
  condition: "element_matches",
  target: { port?, tabId?, by: "text"|"regex"|"role"|"ariaLabel", pattern: string, scope?: string },
  timeoutMs?: 5000
}) → ok({ elapsedMs, observed: { selector, text } })
```
- pollUntil (ideals-plan Phase 0.2) を 1:1 で使う
- 内部実装は `browser_search` を間隔 200ms で叩き、results.length > 0 になれば return

### X-3. Phase 2.1 post narration 除外リストに追加
`browser_search` は **観測系**（state を変えない）ので、ideals-plan Phase 2.1 の post narration は **付けない**。mouse_move / scroll / screenshot / get_windows / get_ui_elements と同じ扱い。

### X-4. suggest 辞書（ideals-plan Phase 1.1）
- `BrowserSearchNoResults`
- `BrowserSearchTimeout`

---

## 修正・追加ファイル

| ファイル | 変更 |
|---|---|
| `src/tools/browser.ts` | browser_search handler 追加（既存 IIFE パターン踏襲） |
| `src/tools/macro.ts:35-59` | TOOL_REGISTRY 登録 |
| `src/tools/_errors.ts` (Phase 1.1 成果物) | X-4 の 2 エントリ追加 |
| `src/engine/poll.ts` (Phase 0.2 成果物) | X-2 condition `element_matches` 対応 |
| `src/index.ts:21-167` | LLM instruction text 更新（browser_search + wait_until 新 condition） |

---

## Verification Plan

1. **build**: `npm run build` が clean に通る
2. **text 完全一致**: GitHub Issues ページで `browser_search({by:"text", pattern:"New issue"})` → `results[0]` が該当ボタン、confidence=1.0
3. **regex**: `by:"regex", pattern:"^Sign", caseSensitive:false` → サインイン系が複数ヒット、confidence=0.90
4. **role**: `by:"role", pattern:"button", scope:"header"` → header 内の button 群のみ
5. **ariaLabel**: `by:"ariaLabel", pattern:"Close"` → aria-label 一致要素、confidence=0.95
6. **scope 限定**: scope 指定あり/なしで total が変化する
7. **ページネーション**: `offset:5, maxResults:5` で next page が返る
8. **hidden**: `visibleOnly:false` で display:none 要素も拾える（confidence が 0.30 減点済）
9. **ヒットなし**: 存在しない pattern → `fail({code:"BrowserSearchNoResults", suggest:[...]})`
10. **confidence 降順**: 複数ヒット時、results[0].confidence >= results[1].confidence
11. **selector 有効性**: `results[0].selector` を `browser_click_element` に渡せて click 成功
12. **wait_until**: `browser_navigate` 直後に `wait_until({condition:"element_matches", target:{by:"text", pattern:"New issue"}, timeoutMs:5000})` が ok
13. **macro**: "navigate → wait → search → click" の 4 ステップマクロが run_macro で動く
14. **既存 browser_***: `browser_find_element` / `browser_get_interactive` / `browser_click_element` 挙動変化なし
15. **既存 e2e**: `tests/e2e/browser-cdp.test.ts` が緑

---

## How to Proceed

1. ideals-plan Phase 0.1 / 0.2 / 1.1 完了を待つ（envelope, pollUntil, failWith が揃う）
2. B-1 `browser_search` 実装 → hands-on 検証 2〜11
3. ideals-plan Phase 1.3 実装時に X-2 condition を同時マージ → 検証 12
4. B-2 TOOL_REGISTRY 登録 → 検証 13
5. confidence 合成規則は **Phase 2.3 OCR confidence と同時リリース** が望ましい（LLM が OCR/UIA/CDP 横断で同軸比較できる）。それ以前でも本プラン単独リリースは可能
6. **全実装完了後 opus で再レビューを実施。指摘があれば修正 → 再レビューを opus の指摘がなくなるまで繰り返す。**
