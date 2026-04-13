# LLMにとって「目と手」になるデスクトップ自動化MCPの理想

> 2026-04-13 — Claude Sonnet 4.6 との対話から生まれたメモ

---

## 核心思想：「座標」ではなく「意味」で世界を記述する

LLMが操作に迷う根本原因は**「今自分が何をしているかわからない状態（福笑い状態）**」にある。
目隠しして顔のパーツを置くように、座標だけを頼りにクリックしている状態。
これを解消するには、操作の前後で「意味」が言語化されることが必要。

---

## 1. 操作の前後で「状態が言語化」されること

**Before（福笑い）**
```
Clicked at (1182, 141)
```

**After（理想）**
```
Clicked "New issue" button (GitHub Issues toolbar)
→ Page navigated to: /issues/new
→ "Title" input is now focused
```

アクションの結果として「世界がどう変わったか」が言葉で返ってくる。
確認のスクリーンショットを撮らなくても次の行動を決められる。

---

## 2. 「なぜそうなったか」が伝わること

現在の `hints` の思想をもっと広げる。

```json
{
  "result": "ok",
  "element": "乗算",
  "why": "matched automationId='multiplyButton'",
  "state": "invoked",
  "windowReady": true
}
```

`state` の候補：`invoked` / `disabled` / `toggled` / `not_found`

- `disabled` なのに押した
- `loading` 中なのに次の操作をした

こうした「空振り」を事前に検知・報告できる。

---

## 3. 「今どこにいるか」の軽量な文脈取得

フルスクリーンショットなしで現在地を把握できるモード。

```json
{
  "focusedWindow": "電卓",
  "focusedElement": "表示エリア (value: '29,232')",
  "cursorNear": "equalButton",
  "pageState": "ready"
}
```

`pageState` の候補：`ready` / `loading` / `dialog` / `error`

`screenshot(detail='meta')` より少し豊かで、`detail='text'` より全然安い。
**「私は今どこにいるか」** が一発でわかる。

---

## 4. 信頼度つきの認識結果

OCRやUIAの結果に「どれだけ信用していいか」が付く。

```json
{
  "name": "Harusame64 / desktop-touch-mcp",
  "source": "ocr",
  "confidence": 0.91
},
{
  "name": "Hョ「し5ョ01を64",
  "source": "ocr",
  "confidence": 0.23
}
```

低信頼（例：0.5未満）の要素には自動でフォールバック戦略を提示する。

```
confidence=0.23: OCR uncertain. Suggest: dotByDot screenshot of region or browser_eval()
```

---

## 5. 操作の「意味のまとまり」で考える

個別ツールの羅列ではなく、意図ベースの操作単位があると嬉しい。

```
navigate_to(window="Chrome", url="...")
fill_form(window="X", fields={title: "...", body: "..."})
wait_until(window="電卓", condition="value_changed")
```

`wait_until` は特に重要。ポーリングのための無駄なスクリーンショットを撮らなくて済む。

---

## 6. 「失敗の説明」が建設的なこと

**今**
```
click_element failed: SyntaxError at position 40
```

**理想**
```
click_element failed: element "テキスト エディター" found but
  InvokePattern not supported on Document type.
  → Try: mouse_click(clickAt) or set_element_value() instead
```

失敗したとき「じゃあ次にどうすればいいか」のヒントがある。
LLMは失敗から学べるが、学ぶための情報が必要。

---

## 7. 「環境の文脈」を一度覚えてくれること

セッション内でウィンドウの構造を学習・キャッシュする。P-frameのUIA版。

```
# 1回目：UIA全取得（重い）
get_ui_elements(windowTitle="電卓")

# 2回目以降：差分だけ
get_ui_elements(windowTitle="電卓", cached=true)
→ "Using cached layout (3s ago). Changed: display value '0' → '29,232'"
```

---

## まとめ

| 今 | 理想 |
|---|---|
| 座標で操作 | 名前・意味で操作 |
| 結果だけ返る | 結果＋理由＋次の手が返る |
| 失敗は例外メッセージ | 失敗は提案つき |
| 毎回フル取得 | 差分・キャッシュ活用 |
| OCRは全部フラット | 信頼度つき |
| 「今どこ」はスクショ | 軽量な文脈API |

---

## 一言でいうと

> LLMが「考えながら操作できる」ツールではなく、**「操作しながら考えられる」ツール**。
