# Dogfood Scenarios — scroll (raw / to_element / smart / capture / read)

- Status: **manual / dogfood scenarios for Phase 2b execution audit**
- Date: 2026-05-09
- Origin: `docs/llm-audit/phase2b-execution-audit.md` §3.4 carry-over
- Scope: scroll 5 actions の実機 GUI 依存シナリオ (特に scroll:to_element / scroll:capture は automated 軸薄、本 doc が SoT)
- Parent audit section: 本 doc §4.x は `phase2b-execution-audit.md` §3.4 (scroll、cell 10-14) の carry-over scenario。各シナリオは parent table の cell 内 `dogfood-scenarios/scroll.md §4.x` 参照と相互リンク

---

## 4. scroll シナリオ

### 4.1 scroll:raw — page-end disambiguation real Notepad (#179 baseline)

**目的**: `tests/unit/scroll-raw-verify.test.ts` の page-end vs silent-drop 区別が real Notepad で end-to-end に正しく分類されることを確認。

**手順**:
1. Notepad 起動、文書を 1 ページ未満で keep
2. **page-end success (no fail)**: `scroll({action:'raw', direction:'down', windowTitle:'Notepad', delta:120})` → 既に底 → response: `ok:true`、`hints.verifyDelivery.status === 'delivered'` (atDirectionalBoundary success)
3. 文書を 100 行 paste、scroll 中段位置に Page Up で戻る
4. **silent drop test**: 文書編集ロック中など特殊状況で scroll → response: `ok:false`、`code:"ScrollNotDelivered"` + reason

**期待**: 境界位置の page-end は silent drop と区別、誤 fail なし。
**Anti-pattern**: page-end も `not_delivered` 判定 → false-positive で agent retry 無限 loop。

### 4.2 scroll:to_element — Chrome iframe / virtualised list 不可達 (E4 dogfood SoT)

**目的**: matrix §3.1 line 147 「entity_outside_viewport 復帰の代理指標として既に厚い」の限界 (iframe boundary / virtualised list の見えない要素) を実機確認。E4 (automated pin gap) の代替 SoT。

**手順**:
- **iframe boundary**: Chrome で iframe 含む page (例: GitHub gist embedded) を開く → iframe 内 element の selector で `scroll({action:'to_element', target:'#nested-iframe-element', windowTitle:'Chrome'})` → CDP `scrollIntoView` で iframe 外 scroll は触れない → `code:"ElementNotFound"` + suggest "iframe 内 element は frame attach が必要"
- **virtualised list**: VS Code editor で 1000+ 行のファイル開く → 表示外 line への scroll:to_element → UIA virtual list で element 不存在 → `code:"VirtualScrollExhausted"` + suggest "use scroll:smart with virtualIndex"
- **viewport 内 success**: 通常 page で表示中 element に scroll:to_element → `ok:true` + element bounds visible 確認

**期待**: 不可達 case は actionable typed code + suggest、success case は entity_outside_viewport recovery contract 保持。
**Anti-pattern**: silent ok:true で element 未到達 → agent が scroll 完了と誤認。

### 4.3 scroll:to_element — viewport edge / scroll container nesting / iframe boundary

**目的**: 4.2 を一般化、scroll container 多重 nest / iframe / shadow DOM 境界での挙動確認。

**手順**:
- nested CSS overflow:auto 内の deeply nested element で scroll:to_element → 多段 scrollIntoView chain が動作
- shadow DOM 内 element selector → CDP `pierce: true` 効果確認

**期待**: 多段 container / shadow DOM で scroll chain が正しく動作、または未対応なら typed code 明示 + suggest。

### 4.4 scroll:to_element → 次 tool chain (mouse_click 等)

**目的**: matrix §3.1 line 147 「entity_outside_viewport 復帰の代理指標として既に厚い」を element 表示 → 次 mouse_click chain の前提条件として確認。

**手順**:
1. Chrome で長 page (Wikipedia 任意) を開く
2. `scroll({action:'to_element', target:'#section-id', windowTitle:'Chrome'})` で section 表示
3. `mouse_click(x, y, windowTitle:'Chrome')` で section 内 button 操作 (Tier 1 commit-axis scope 内 tool)。`click_element` (Tier 2 scope) は Phase 3 audit で扱うため本 phase chain 例から除外
4. button 押下が成功すること

**期待**: scroll:to_element 後の element bounds が viewport 内にあり次 tool が直接 operable。
**Anti-pattern**: scroll は ok:true だが element はまだ viewport 外 → 次 tool で entity_outside_viewport / element_not_in_viewport recovery loop。

### 4.5 scroll:smart — 多経路 strategy 切替 chain (CDP→UIA→image fallback)

**目的**: matrix §3.1 line 148 「多経路 (CDP / UIA / image)」の strategy 切替が real target で fall-through することを確認。

**手順**:
- **CDP path**: Chrome で `scroll:smart` → CDP `scrollIntoView` 成功 → response.strategy='cdp'
- **UIA path**: VS Code (Electron だが UIA 経由可) で同 → CDP 不可達 → UIA ScrollItemPattern → response.strategy='uia'
- **image path**: ScreenSettings (UWP / WinUI) で同 → UIA も部分対応 → image hash diff fallback → response.strategy='image' or warning で degradation

**期待**: 各 strategy で適切に fall-through、最終 fallback で `OverflowHiddenAncestor` / `VirtualScrollExhausted` typed code emit。
**Anti-pattern**: CDP 不可達で即 fail、UIA fallback 動作しない (`tests/unit/scroll-ancestors.test.ts` の strategy 切替が production 経路で動作してない)。

### 4.6 scroll:capture — Edge 縦長 page capture frame seam (E5 dogfood SoT)

**目的**: matrix §3.1 line 149 「frame seam + sizeReduced flag で degradation 表現」を real Edge で確認。E5 (automated pin gap、defer 候補) の代替 SoT。

**手順**:
1. Edge で 5000px 以上の縦長 page を開く (Wikipedia 長文 / Reddit thread 等)
2. `scroll({action:'capture', windowTitle:'Edge', maxPages:10})` 呼出
3. response 観測: `pages` が複数返り、各 page の image data + frame seam flag (重複部分の overlap), `sizeReduced:true` (size limit 適用) の場合 hint で warning emit
4. seam 位置で content が visible に再現できること (text content 連続性)

**期待**: capture が page 越えで text continuity を維持、size reduced は明示的 warning。
**Anti-pattern**: silent truncation、frame seam 重複で content が欠落 / 重複。

### 4.7 scroll:capture — capture 失敗 / OOM / 巨大 viewport edge

**目的**: 異常系 (OOM / 巨大 viewport / cross-monitor) で graceful degrade することを確認。

**手順**:
- 4K monitor 全画面で `scroll:capture` → image size 大、size reduce 適用 + warning
- multi-monitor で window が monitor 跨ぎ → cross-monitor capture で各 monitor 別 + warning
- low-memory simulator で Edge 開いた状態で capture → OOM 時 ok:false + suggest

**期待**: 各異常系で typed code + suggest、silent crash なし。

### 4.8 scroll:capture — HiDPI / 縦長 200+ row / Chrome native scroll edge

**手順**:
- 200% display scaling Windows 環境で `scroll:capture` → real pixel と CSS pixel の coord 一貫性
- Chrome で `overflow:auto` 内の縦長 200+ row scroll → native scroll bar interaction
- 各 case で frame seam + sizeReduced flag

**期待**: HiDPI で coordinate transform 正確、Chrome native scroll で frame seam 一貫。

### 4.9 scroll:capture → screenshot → OCR chain

**目的**: capture 結果を agent が次 tool (`screenshot` の OCR / vision model 解析) に feed する chain。

**手順**:
1. `scroll:capture` で 5 page 取得
2. 各 page の image を順次 `screenshot:detail='text'` 経由 OCR (但し scroll:capture は既に ocrLanguage 指定可、内部で OCR chain あり)
3. `scroll:read` 経路 (next section 4.x) と比較

**期待**: capture は image 軸、`scroll:read` は OCR 直接軸、agent は use case で使い分け可。

### 4.10 scroll:read — Chromium-class skip + foreground fallback (round-5 regression)

**目的**: `tests/unit/scroll-read.test.ts:600-657` の Chromium-class skip + foreground fallback が real Chrome で end-to-end に動作することを確認。

**手順**:
1. Chrome 起動、長 article 開く
2. `scroll({action:'read', windowTitle:'Chrome', maxPages:5, scrollKey:'PageDown'})` 呼出
3. response 観測: pages 複数 + dedup 効果 + stoppedReason
4. internally: `canInjectAtTarget` が `{supported:false, reason:'chromium'}` 返す → BG path skip → foreground fallback で focus 再設定

**期待**: Chrome のような Chromium-class でも foreground fallback で OCR 可。
**Anti-pattern**: BG path silent fail で stoppedReason='no_change' 即 termination (#173/179 同型)。

---

## 共通操作上の note

- **scrollKey**: `PageDown` (default) / `ArrowDown` / `End` / `Home` の 4 値、Chromium で `End` は無視されるなど挙動差あり。
- **stopWhenNoChange**: 2 連続 no-new-line で停止、long-tail content (chat history 等) に有効。
- **maxPages**: 1-50 範囲、超長 page は手動 partial 設計推奨。
- **OCR language**: `detectOcrLanguage` で OS locale から自動 (ja / zh / en 等)、明示 override も可能。
- **HiDPI**: scroll-capture 系では `region.width/height` が CSS pixel、screenshot 系では device pixel な実装注意 (regression 多発箇所)。
