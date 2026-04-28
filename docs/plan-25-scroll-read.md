# Plan: #25 `scroll_read` — スクロール + OCR を 1 呼び出しで完結

- **Issue**: https://github.com/Harusame64/desktop-touch-mcp/issues/25
- **Label**: enhancement, v1.1
- **想定スコープ**: 2 PR 推奨 (Phase 1 + Phase 2)。Phase 3 は将来
- **作成日**: 2026-04-28

---

## 重要な設計判断: 新ツール vs 既存 dispatcher の action 追加

### 前提知識

`src/tools/scroll.ts` は **dispatcher パターン**で、MCP には **1 つのツール `scroll`** しか公開していない。LLM はそのツール内の `action` パラメータで挙動を切り替える:

```
scroll({action: 'raw',         direction: 'down', amount: 5})           # 純粋なホイール
scroll({action: 'to_element',  name: 'OK', windowTitle: 'Dialog'})      # 要素を viewport に
scroll({action: 'smart',       target: '#btn'})                          # 多戦略フォールバック
scroll({action: 'capture',     windowTitle: 'Chrome'})                   # 全ページ画像化
```

これは **Phase 2 (Family Merge)** という明示的な project goal の結果で、PR #36 / #37 / #38 / #39 で他の家族（window-dock 等）も同じ統合をしてきた。v1.0.0 release prep の柱。

### 案 A: 新ツール `scroll_read` として独立公開

LLM のツール一覧に **2 つ目のスクロール系ツール** が現れる:

```
- scroll(action: raw|to_element|smart|capture, ...)
- scroll_read(windowTitle, maxPages, ...)        ← 新規
```

**コード構造:**
- `src/tools/scroll-read.ts` 新規（schema + handler + register 関数）
- `src/server-windows.ts` に `registerScrollReadTool(server)` 追加
- `scripts/generate-stub-tool-catalog.mjs` の `TOOL_FILES` に `'scroll-read.ts'` 追加
- `src/stub-tool-catalog.ts` 自動再生成

**メリット:**
- ツール名 `scroll_read` 自体が機能を表す → LLM の prompt に「scroll_read で読んで」と書ける
- grep で意図ごとに引ける（`scroll_read` 単独で）
- Issue タイトルと完全一致
- scroll() の discriminatedUnion が肥大化しない

**デメリット:**
- ツール総数が 1 つ増える（v1.0.0 の Tool Surface Reduction 方針に逆行）
- LLM 視点では「スクロールしたい」とき選択肢が 2 つに増えて迷いやすい
- README ツール表が +1 行
- `scroll(action='capture')` と `scroll_read()` の使い分けを caveats で説明する必要

### 案 B: `scroll(action='read')` として既存 dispatcher に追加

```
scroll({action: 'raw',         ...})
scroll({action: 'to_element',  ...})
scroll({action: 'smart',       ...})
scroll({action: 'capture',     ...})
scroll({action: 'read',        windowTitle: '...'})    ← 追加
```

**コード構造:**
- `src/tools/scroll-read.ts` 新規（handler のみ、schema は scroll.ts に書く）
- `src/tools/scroll.ts` の discriminatedUnion に 1 ブランチ追加、dispatchHandler に case 追加、buildDesc 拡張
- TOOL_FILES 修正不要（`scroll.ts` は既に登録済）
- `server-windows.ts` 修正不要（既存の `registerScrollTools` がそのまま動く）

**メリット:**
- ツール総数 ±0（Phase 2/3 方針と整合）
- LLM の選択肢が「スクロール系は scroll() 1 個」で一貫
- stub-tool-catalog 修正 0 箇所
- `scroll(action='capture')` (画像) と `scroll(action='read')` (テキスト) が同じ家族で並ぶ → 使い分けが自然

**デメリット:**
- ツール名で `scroll_read` を grep できない（`action: "read"` で検索する必要）
- Issue タイトル `scroll_read` とは命名が異なる
- discriminatedUnion が 4 → 5 ブランチに膨らむ（許容範囲）
- LLM が「OCR で長文を読む」機能を発見するには scroll の examples / prefer 文を読む必要

### 推奨

**案 B (`scroll(action='read')`) を推奨**します。理由:

1. **方針整合**: Phase 2/3 で「family merge → ツール総数削減」を意図的に進めてきた直後に、新規 top-level ツールを足すのは設計判断として一貫性を欠く
2. **使い分けの自然さ**: `scroll(action='capture')` (= 画像で読む) と `scroll(action='read')` (= テキストで読む) は対の関係で、同じ家族に並べた方が直感的
3. **保守コスト**: stub-tool-catalog 修正 / register 追加 / 公開 API 増加が無く、PR が薄い
4. **LLM 発見性は description で補える**: scroll() の `prefer` 文に「長文ドキュメント読み取りには action='read'」と書けば誘導できる（capture との使い分け含めて）

**反対意見の余地**:
- 「LLM はツール名で機能を選ぶ傾向があり、`scroll_read` の方が見つかりやすい」という主張は一理ある。ただし現状 `scroll(action='capture')` も「画像化」という別機能を内包していて、これが見つからずに困った報告は memory に無い。
- 将来 scroll の action が 7-8 個に膨らんだら family を割る必要が出るが、現時点では 5 個は健全範囲。

**もし案 A にしたい場合の差分**: 約 30-40 行（schema/handler を別ファイルに切り出し、register 関数追加、TOOL_FILES に追加）。後から A → B、B → A への移行は 1 回ずつなら低コスト。

→ **判断はユーザーに委ねます**。OK なら B で進めます。

---

## 解決策

`scroll(action='read')` を新設。サーバ側で「スクロール → OCR → 重複行除去 → 末尾判定」を完結し、結合済みテキストを返す。

### 入力

```ts
z.object({
  action: z.literal("read"),
  windowTitle: z.string().describe("Partial window title (case-insensitive)."),
  maxPages: z.coerce.number().int().min(1).max(50).default(20).describe(...),
  scrollKey: z.enum(["PageDown", "Space", "ArrowDown"]).default("PageDown").describe(...),
  scrollDelayMs: z.coerce.number().int().min(100).max(3000).default(400).describe(...),
  stopWhenNoChange: coercedBoolean().default(true).describe(...),
  language: z.string().optional().describe(
    "OCR language code (e.g. 'ja', 'en', 'zh'). Omit to auto-detect from Windows system locale " +
    "(via Intl.DateTimeFormat().resolvedOptions().locale). Default: auto."
  ),
})
```

### 出力 JSON

```json
{
  "ok": true,
  "text": "…結合済テキスト…",
  "pages": 7,
  "stoppedReason": "no_change" | "max_pages" | "ocr_empty",
  "dedupedLines": 42,
  "perPage": [
    { "page": 1, "addedLines": 35, "duplicateLines": 0 },
    { "page": 2, "addedLines": 28, "duplicateLines": 7 }
  ]
}
```

### スコープ外（明示）

- **Phase 1 では対象外**: PDF 横スクロール / Markdown 整形 / grep モード（issue 本文の「将来拡張」）
- **Phase 1 では対象外**: browser (CDP) 版 — Phase 3 で別途
- **画像出力は無し**: OCR テキストのみ。視覚情報必要なら `scroll(action='capture')` を使う

---

## Phase 分割

### Phase 1: Native スクロール + OCR + 単純な重複除去 (本 PR)

最小実装。重複除去は「直前ページの末尾 N 行が新ページ先頭に含まれる場合に削除」の素朴アルゴリズム。

#### 設計

**ファイル: `src/tools/scroll-read.ts` 新規**

```ts
import { recognizeWindow, ocrWordsToLines } from "../engine/ocr-bridge.js";
import { keyboard } from "@nut-tree-fork/nut-js";  // Page Down 送信
import { focusWindowByTitle } from "../engine/win32.js";

/**
 * Detect OCR language from Windows system locale.
 * Returns a primary language tag (e.g. "ja", "en", "zh") that win-ocr.exe accepts.
 * Falls back to "en" for unrecognized locales.
 */
function detectOcrLanguage(): string {
  // Intl.DateTimeFormat().resolvedOptions().locale returns BCP-47 e.g. "ja-JP", "en-US"
  // It reads OS preferred language on Windows (CRT inherits from GetUserDefaultLocaleName)
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const primary = locale.split("-")[0]?.toLowerCase() ?? "en";
  // win-ocr.exe / Windows.Media.Ocr supports languages installed in OS.
  // We pass primary tag; if the OS lacks the pack, win-ocr returns error which we fall back to "en".
  const KNOWN = new Set(["ja", "en", "zh", "ko", "fr", "de", "es", "it", "pt", "ru", "nl", "pl", "tr", "ar"]);
  return KNOWN.has(primary) ? primary : "en";
}

export interface ScrollReadResult {
  ok: boolean;
  text: string;
  pages: number;
  language: string;  // 実際に使った言語（自動検出結果のレポート）
  stoppedReason: "no_change" | "max_pages" | "ocr_empty";
  dedupedLines: number;
  perPage: Array<{ page: number; addedLines: number; duplicateLines: number }>;
}

export async function scrollReadHandler(args: ScrollReadArgs): Promise<ToolResult> {
  const language = args.language ?? detectOcrLanguage();
  await focusWindowByTitle(args.windowTitle);
  await new Promise(r => setTimeout(r, 200));  // focus settle

  const allLines: string[] = [];
  const perPage: Array<{ page: number; addedLines: number; duplicateLines: number }> = [];
  let stoppedReason: "no_change" | "max_pages" | "ocr_empty" = "max_pages";
  let noChangeStreak = 0;

  for (let page = 1; page <= args.maxPages; page++) {
    // OCR current viewport
    const { words } = await recognizeWindow(args.windowTitle, language);
    const lineText = ocrWordsToLines(words);
    const lines = lineText.split("\n").map(s => s.trim()).filter(Boolean);

    if (lines.length === 0) {
      stoppedReason = "ocr_empty";
      break;
    }

    // Dedupe: longest suffix-of-allLines that is a prefix-of-lines
    const dupCount = findOverlap(allLines.slice(-20), lines);
    const newLines = lines.slice(dupCount);

    perPage.push({ page, addedLines: newLines.length, duplicateLines: dupCount });
    allLines.push(...newLines);

    if (args.stopWhenNoChange && newLines.length === 0) {
      noChangeStreak++;
      if (noChangeStreak >= 2) {
        stoppedReason = "no_change";
        break;
      }
    } else {
      noChangeStreak = 0;
    }

    if (page === args.maxPages) break;

    // Send scroll key
    await keyboard.pressKey(keyMap[args.scrollKey]);
    await keyboard.releaseKey(keyMap[args.scrollKey]);
    await new Promise(r => setTimeout(r, args.scrollDelayMs));
  }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ok: true,
        text: allLines.join("\n"),
        pages: perPage.length,
        language,                 // 自動検出 or 引数指定の値をエコー
        stoppedReason,
        dedupedLines: perPage.reduce((s, p) => s + p.duplicateLines, 0),
        perPage,
      }, null, 2),
    }],
  };
}

/** Longest suffix-of-prev that equals prefix-of-curr. Naive O(n*m), n,m <= 20. */
function findOverlap(prev: string[], curr: string[]): number {
  const maxOverlap = Math.min(prev.length, curr.length);
  for (let k = maxOverlap; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== curr[i]) { match = false; break; }
    }
    if (match) return k;
  }
  return 0;
}
```

#### 既存資産の流用

- `recognizeWindow(windowTitle, language)` (`src/engine/ocr-bridge.ts:247-284`) — ウィンドウキャプチャ + OCR、ローカル座標で `OcrWord[]` 返す
- `ocrWordsToLines(words)` (`src/engine/ocr-bridge.ts:291-311`) — y-midpoint クラスタリングで行配列 → 改行区切り文字列
- `focusWindowByTitle()` — 既存の win32 ヘルパ
- nut-js `keyboard.pressKey/releaseKey` — 既存パターン (`src/tools/keyboard.ts:78-82`)

#### dispatcher 統合 (`src/tools/scroll.ts`)

```ts
// 追加
import { scrollReadHandler } from "./scroll-read.js";

export const scrollSchema = z.discriminatedUnion("action", [
  // 既存4つ
  z.object({ action: z.literal("raw"), ... }),
  z.object({ action: z.literal("to_element"), ... }),
  z.object({ action: z.literal("smart"), ... }),
  z.object({ action: z.literal("capture"), ... }),
  // 追加
  z.object({
    action: z.literal("read"),
    windowTitle: z.string()...,
    maxPages: z.coerce.number()...,
    scrollKey: z.enum([...])...,
    scrollDelayMs: z.coerce.number()...,
    stopWhenNoChange: coercedBoolean()...,
    language: z.enum(["ja", "en"]).default("ja")...,
  }),
]);

export const scrollDispatchHandler = async (args: ScrollArgs): Promise<ToolResult> => {
  switch (args.action) {
    case "raw":         return rawScrollHandler(args);
    case "to_element":  return scrollToElementHandler(args);
    case "smart":       return smartScrollHandler(args);
    case "capture":     return scrollCaptureHandler(args);
    case "read":        return scrollReadHandler(args);  // ★ 追加
  }
};
```

`registerScrollTools()` の `buildDesc` 内 `details` / `prefer` / `examples` に `read` の説明を追加。

#### テスト (`tests/unit/scroll-read.test.ts` 新規)

1. **`findOverlap` 単体**:
   - `findOverlap(["a","b","c"], ["b","c","d"])` → 2
   - `findOverlap(["a","b"], ["c","d"])` → 0
   - 空配列対応

2. **handler ドライラン** (重い OCR / nut-js は mock):
   - `recognizeWindow` mock で 3 ページ分の `OcrWord[]` を返す → 期待 text と pages 確認
   - 連続2回 newLines=0 → stoppedReason="no_change"
   - maxPages 到達 → stoppedReason="max_pages"
   - OCR 空配列 → stoppedReason="ocr_empty"

3. **schema 検証**:
   - default 値、enum 制約、min/max 制約

E2E は手動 smoke test で notepad / browser / VS Code 等を実機確認 (ただし notepad-launcher MSStore hang 問題に注意 — memory: feedback_notepad_launcher_msstore_hang.md)。

---

### Phase 2: 重複除去精緻化 (別 PR、後日)

Phase 1 の素朴アルゴリズムでは以下のケースで誤検出する:

- 改行位置が微妙にずれた場合（OCR ノイズで "abc def" / "abc  def" が別行扱い）
- ヘッダ / フッタが固定で残るページ（ページ番号 "1/10" → "2/10" など）

#### 検討する改善

- 文字列正規化 (連続空白圧縮 / トリム / 全角/半角統一)
- ページ末尾 / 先頭の固定領域検出 (Y 座標クラスタ)
- 単語ベースではなく行ベースの Levenshtein 編集距離 (閾値 < length × 0.1)

実装前に Phase 1 の dogfood で「実際にどこで誤検出するか」を観察してから、必要な精緻化のみ入れる (over-engineering 防止)。

---

### Phase 3: Browser (CDP) 版 (将来、別 PR)

ブラウザ内では JS で `document.body.innerText` を直接取れるので OCR 不要、精度が圧倒的に高い。`browser_get` 等の既存ブラウザ系ツールで賄えるなら不要かもしれない (issue を再評価)。

---

## 影響範囲

### 触るファイル (Phase 1)

| File | 変更 |
|---|---|
| `src/tools/scroll-read.ts` | 新規 (ハンドラ + findOverlap) |
| `src/tools/scroll.ts` | discriminatedUnion に `read` 追加、dispatcher case 追加、buildDesc 拡張 |
| `tests/unit/scroll-read.test.ts` | 新規 |

### 触らないファイル (action 追加のため)

- `src/stub-tool-catalog.ts`: 自動再生成
- `scripts/generate-stub-tool-catalog.mjs`: TOOL_FILES に既に `scroll.ts` 含む (line 16)
- `src/server-windows.ts`: 既存 `registerScrollTools` をそのまま呼ぶ
- `src/engine/ocr-bridge.ts`: 既存関数 (`recognizeWindow`, `ocrWordsToLines`) を import するのみ、変更なし

→ **stub-tool-catalog の 3 箇所登録は今回 0 箇所** (= dispatcher 統合の利点)

---

## チェックリスト (Phase 1)

- [ ] `src/tools/scroll-read.ts` 新規作成
- [ ] `src/tools/scroll.ts` discriminatedUnion に `read` action 追加
- [ ] `src/tools/scroll.ts` dispatchHandler に case 追加
- [ ] `src/tools/scroll.ts` `buildDesc` の details/prefer/examples に read 説明追加
- [ ] `tests/unit/scroll-read.test.ts` 新規 (findOverlap + handler mock + schema)
- [ ] `npm run generate-stub-catalog` 実行 (auto-gen 反映確認)
- [ ] `npm run build` 通過
- [ ] `npm run test:capture > .vitest-out.txt` で全 unit pass
- [ ] 手動 smoke test: notepad / chrome / vscode で `scroll(action='read', windowTitle:'...')` 動作確認
- [ ] Opus レビュー → 指摘ゼロまで反復
- [ ] PR 出す (label: v1.1, closes #25)

---

## ユーザー判断ログ (2026-04-28)

1. **新ツール vs action 追加**: 詳細比較を本ドキュメント上部「重要な設計判断」に追記済み。判断はユーザーへ。
2. **OCR 言語**: ✅ Windows OS locale から自動切替 (Intl.DateTimeFormat().resolvedOptions().locale)。`detectOcrLanguage()` 実装済（ハンドラ内）
3. **`scrollKey` 送信**: ✅ nut-js (前景必須) で進める
