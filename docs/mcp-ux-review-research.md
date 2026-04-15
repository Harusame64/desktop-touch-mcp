# desktop-touch-mcp — 2026-04-15 セッションの MCP 操作感レビュー & 改善提案

## Context

v0.6.4 リリース後、Glama の Create Release フォームを MCP 経由で操作して公開するタスクで発生した摩擦を振り返り、次版以降の改善案をまとめる。

対象セッション: 2026-04-15、Glama Admin → Dockerfile → Test → Create Release の一連の操作。

目的: 「何がスムーズだったか / 何で詰まったか」を可視化し、改善優先度を決める判断材料にする。

---

## Implementation Status

### v0.6.5 (2026-04-15)

Branch: `feat/description-v0.6.5` — PR #11.

Shipped:
- [x] Prio 1-A: `keyboard_type` caveat for em-dash/en-dash/smart-quote Chrome/Edge accelerator hijack (`src/tools/keyboard.ts`)
- [x] Prio 2-A: `browser_eval` caveat for React/Vue/Svelte controlled inputs (`src/tools/browser.ts`)
- [x] Prio 3-A: `focus_window` WindowNotFound suggest — Chrome/Edge tab hint via `browser_connect` (`src/tools/_errors.ts`)
- [x] Prio 3.5-E: `scroll_capture` prefer clause — whole-page overview vs `scroll + screenshot(detail='text')` for partial verification (`src/tools/scroll-capture.ts`)
- [x] Prio 6-A: `browser_get_interactive` as first-choice form verification over screenshot (`src/tools/browser.ts`)

Deferred to v0.7+: see the original "v0.7 検討候補" block below (unchanged).

Token impact (tools/list descriptions): 22,200 chars (v0.6.4) → 23,313 chars (v0.6.5) — delta +1,113 chars ≈ **+278 tokens**.

---

## 今回スムーズに動いた部分

| 操作 | 評価 |
|---|---|
| `screenshot(detail='image', dotByDot=true, dotByDotMaxDimension=1280, windowTitle='Chrome')` | origin + scale を返してくれるので座標計算が不要、安定 |
| `mouse_click(origin={...})` | 画像座標をそのまま渡せる、windowTitle 補正も効く |
| `keyboard_type(use_clipboard=true)` | 一度パターンを覚えれば堅牢、PowerShell 経由でも ~4秒で完了 |
| `keyboard_press('ctrl+a')` | 意図通りの text 全選択 |
| `browser_launch` / `browser_connect` で Chrome debug 起動 | 今回使わなかったがパスは通った |

---

## 詰まった / 改善したい点（重要度順）

### Prio 1 — em-dash (`—`) で Chrome アドレスバーにフォーカスを奪われた

**事象:** `keyboard_type` で Changelog に `Tier-based description rewrite ... — scroll_capture ...` を送信したところ、`—` の入力でアドレスバーにフォーカスが移り、続く文字列が Google 検索クエリとして扱われた。

**原因推測:** Chrome の accelerator / OS の IME / keyboard layout のいずれかで `—` がショートカット扱いされる。キーストローク送信経路（nut.js → Windows SendInput）だとブラウザ側に raw key として届く可能性。

**現状の description:**
```
Caveats: ... Does not handle IME composition for CJK — use use_clipboard=true or set_element_value instead.
```
CJK のみ警告しており、em-dash / en-dash / smart quote などの「keyboard shortcut に化ける記号」は言及なし。

**改善案:**
- A. description 強化: "URLs, paths, or text containing em-dash / en-dash / smart quotes → use use_clipboard=true" を caveat に追加。
- B. `keyboard_type` に事前スキャンを入れ、非 ASCII 印字記号を検出したら自動で clipboard 経路に切替（opt-out 可能な `forceKeystrokes: true`）。
- C. `use_clipboard` のデフォルトを `true` にする（破壊的変更）。

**推奨:** A を v0.6.5 で即実施、B を v0.7 で検討。C は破壊的なので見送り。

### Prio 2 — React controlled input を `browser_eval` から更新できない

**事象:** Version フィールドに browser_eval で `input.value = '0.6.4'` / `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, '0.6.4')` + `dispatchEvent('input'/'change')` を試行 → React の state に反映されず、submit しても空扱い。最終的にネイティブキーボード入力に fallback して成功。

**原因:** React 18 の synthetic event システムは setter を監視しているが、fiber 側の state 更新には更に条件がある（useState の setter 呼び出しが必要）。DOM レベルの event dispatch では足りないライブラリ／コンポーネントもある。

**改善案:**
- A. `browser_eval` description の Caveats に「React/Vue controlled inputs won't update state via JS — use keyboard_type or CDP Input.insertText」を追加。
- B. `browser_fill_input(selector, value)` を追加: CDP `Input.dispatchKeyEvent` を `focus → selectAll → type` の手順で流す。React/Vue に関係なく動く。
- C. 既存の `set_element_value` は UIA 経由なので Chrome では効かないことも明記。

**推奨:** A を v0.6.5 で実施、B を中期で検討（browser-first タスクでは十分有用）。

### Prio 3 — `focus_window(windowTitle='Glama')` が Chrome タブ切替後に WindowNotFound

**事象:** Chrome が Google 検索タブに切り替わった状態で `focus_window('Glama')` を呼んだところ、Chrome のウィンドウタイトルが `"per-tool ... - Google 検索 - Google Chrome"` になっていたため部分一致せず WindowNotFound。代わりに `'Chrome'` で focus_window すると Google 検索タブに飛んでしまった。

**原因:** Chrome は全タブで 1 HWND。OS から見えるのは active tab の title だけ。

**改善案:**
- A. error の suggest[] に「If target is a Chrome tab, use browser_connect + activate via tab URL」を追加。
- B. `focus_window` に `chromeTabUrlContains: string` パラメータを追加し、CDP で該当タブを activate してから HWND foreground する。
- C. `browser_connect` の結果に tab 一覧を含め、ユーザが `browser_activate_tab(tabId)` を呼べるようにする（既存 API との整合性要確認）。

**推奨:** A を v0.6.5 で実施（低コスト）。B/C は browser.ts の大きい拡張なので別 PR。

### Prio 3.5 — スクロール操作が全般的に辛い

**事象:** LLM エージェントが scroll / scroll_capture 周りで繰り返し詰まるパターンが多い。今回のセッションでは Glama のフォームが画面外にあり、見つけるまでに screenshot を繰り返した。

**具体的な痛点:**
1. **スクロールコンテナの特定が困難**: SPA では `document.body` ではなく内部 `<div>` がスクロール可能なことが多い。`scroll(dx, dy)` は active window/focused element の上でしか効かず、「この div をスクロールしたい」の指定ができない。
2. **目的要素までの距離が分からない**: 「あと何回スクロールすれば Create Release が出るか」を LLM は推論で決めるしかなく、2〜5 回の試行錯誤になる。
3. **`scrollIntoView` 相当の高位 API がない**: Chrome なら `browser_eval` で `el.scrollIntoView()` を呼ぶしかない。native window では該当 API 自体ない。
4. **scroll 後の座標が陳腐化**: 直前の screenshot で得た clickAt が scroll 後には別の要素を指す。自動 invalidate されない。
5. **`scroll_capture` は高価だが代替がない**: 長いページ全体の把握には必要。1MB guard は入ったが、読む側（LLM）のトークンコストは依然高い。
6. **scroll の方向と単位が曖昧**: `dx, dy` の pixel 指定か wheel notch 指定か、UI 側でどう解釈されるかが DPI / 設定依存。

**改善案:**
- A. `scroll_to_element(name | selector)` 系の高位 API: Chrome なら CDP `Runtime.evaluate` で `scrollIntoView({block:'center'})`、native なら UIA `ScrollItemPattern`。
- B. `screenshot(detail='text')` の各 actionable に `viewportPosition: 'in-view' | 'above' | 'below'` を含める。これがあれば LLM は「下にスクロールすべき」と即判断できる。
- C. `scroll` に `container: selector` パラメータを追加（Chrome 限定）、CDP で該当要素を scroll。
- D. scroll 後、自動で次 screenshot を同じセッションで撮る `scroll(..., captureAfter: true)` オプション。座標の陳腐化問題を1アクション内で解消。
- E. `scroll_capture` の description で「全体俯瞰が目的」「部分的 verify には scroll + screenshot(detail='text')」の使い分けを明記。

**推奨:**
- B (viewportPosition) が費用対効果最大 — `get_ui_elements` / `browser_get_interactive` / `screenshot(detail='text')` 全てに足せる。
- A (scroll_to_element) は Chrome だけ先に入れ、native は後回し。
- C/D は scroll API の拡張。

### Prio 4 — 「既存値を全選択して上書き」がワンアクションでできない

**事象:** Version フィールドの `0.6.3` を `0.6.4` に置換するため、click → ctrl+a → keyboard_type の 3 step が必要。

**改善案:**
- A. `keyboard_type` に `replaceAll: boolean` パラメータを追加。true なら送信前に `ctrl+a` を自動送出。
- B. `mouse_click` に `tripleClick: boolean` を追加（テキスト行全選択）。`doubleClick` と同じ系譜。
- C. `set_element_value` は既に replace 動作だが UIA なので Chrome では使えない。

**推奨:** A を v0.6.5、B は mouse_click の拡張として検討。

### Prio 5 — Toast でボタンが隠れるケースへの対応

**事象:** 今回は問題なかったが、"Release Created" トーストが右上に出る際、次のステップで別の UI に到達する経路でトーストが遮蔽する可能性。

**改善案:**
- `wait_until(element_matches, selector='.toast-dismiss')` のような DOM 待機プリセットがあると良い。
- 現状 `wait_until` は generic で対応可能なので description に例示を追加する程度で十分。

**推奨:** 低優先度、ドキュメント改善のみ。

### Prio 6 — 実装後の verification screenshot に過剰に依存

**事象:** フォーム入力のたびに screenshot で結果確認した。本来 `narrate: 'rich'` の post.rich.valueDeltas を見れば十分なはずだが、browser 内要素には反応しない（UIA 範囲外）。

**改善案:**
- A. `browser_get_interactive` は既に値を返せるので、フォーム入力後の verify はこれで代替できることを description で強調。
- B. `keyboard_type` の rich narration に「CDP 経由で focused 要素の value 差分を返す」拡張（browser_connect 済みの場合のみ）。

**推奨:** A を v0.6.5 で description 微修正、B は中期検討。

---

## Out of Scope（今回は触らない）

- Glama 固有の UI 解釈支援（ベンダー依存）
- `keyboard_type` の nut.js → SendInput 直呼び化（パフォーマンス最適化）
- Chrome 以外のブラウザ対応

---

## 改善まとめ

**v0.6.5 候補（description / documentation 中心、破壊的変更なし）:**
1. `keyboard_type` caveat: em-dash / en-dash / smart quotes も use_clipboard 推奨（Prio 1-A）
2. `browser_eval` caveat: React/Vue controlled inputs は JS で state 更新不可（Prio 2-A）
3. `focus_window` WindowNotFound の suggest に Chrome タブケースを追加（Prio 3-A）
4. `scroll_capture` vs `scroll+screenshot` の使い分けを description に明記（Prio 3.5-E）
5. `browser_get_interactive` を form verification の第一選択として description で強調（Prio 6-A）

**v0.7 検討候補（機能追加、要設計）:**
1. **`viewportPosition` フィールドを各 actionable に追加**（Prio 3.5-B）— 費用対効果最大候補
2. **`scroll_to_element(name | selector)`** API 新設（Prio 3.5-A）
3. `browser_fill_input(selector, value)` — CDP 経由で React/Vue 対応（Prio 2-B）
4. `scroll` に `container: selector` / `captureAfter: true` 拡張（Prio 3.5-C/D）
5. `keyboard_type` の `replaceAll: true` パラメータ（Prio 4-A）
6. `mouse_click` の `tripleClick: true` パラメータ（Prio 4-B）
7. `focus_window(chromeTabUrlContains)` または `browser_activate_tab` API（Prio 3-B/C）
8. `keyboard_type` の非 ASCII 記号自動検出 → 自動 clipboard 切替（Prio 1-B）

---

## Critical Files（参考）

- `src/tools/keyboard.ts` — description 修正の主対象（v0.6.5）
- `src/tools/browser.ts` — browser_eval / browser_fill_input の対象
- `src/tools/window.ts` — focus_window の suggest 拡張
- `src/tools/_errors.ts` — suggest 辞書

---

## 検証方針（将来 PR 時）

- em-dash テスト: `keyboard_type('a—b')` を Chrome address bar / 通常テキストエリアに打ち、focusLost が出ないことを確認
- React form テスト: Glama 互換のテスト用 React フォームを `tests/e2e/fixtures/` に置いて browser_fill_input の success / UIA set_element_value の失敗を両方検証
- focus_window suggest テスト: Chrome を特定タイトルでないタブにした状態で focus_window('xxx') → error.suggest に Chrome tab hint が含まれる
