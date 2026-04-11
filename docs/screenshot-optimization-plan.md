# Screenshot 最適化: Dot-by-Dot + レイヤー差分モード

## Context

現在のスクリーンショットは `maxDimension=768` にスケーリングされるため、画像上の座標を画面座標に変換する計算（`screen_x = window_x + screenshot_x / scale`）が毎回必要で、マウス操作のたびにエラーを生む。

**目的:**
1. ピクセル座標 = 画面座標になる 1:1 モードの導入（WebP 圧縮で軽量化）
2. RDP/MPEG のようなレイヤー差分モードで、変化したウィンドウだけ再送信

---

## Phase 1: WebP エンコーディング基盤

**変更ファイル:** `src/engine/image.ts`

### 1-1. CaptureResult の mimeType を拡張
```typescript
mimeType: "image/png" | "image/webp"
```

### 1-2. WebP エンコード関数を追加
```typescript
async function encodeToWebP(
  rawData: Buffer, srcWidth: number, srcHeight: number,
  channels: 3 | 4, quality: number
): Promise<CaptureResult>
```
- `sharp(rawData, {raw}).webp({quality}).toBuffer()`
- リサイズなし（1:1）
- デフォルト quality=60（テキスト読める最低ライン）

### 1-3. キャプチャ関数にオプション追加
`captureScreen` / `captureWindowBackground` / `captureDisplay` に：
```typescript
interface CaptureOptions {
  maxDimension?: number;   // 既存: スケーリング（デフォルト1280）
  format?: "png" | "webp"; // 新規: 出力形式（デフォルト"png"）
  webpQuality?: number;    // 新規: WebP品質 1-100（デフォルト60）
}
```
- `format="webp"` の場合、`encodeToWebP` を使用（リサイズなし）
- `format="png"` の場合、従来通り `encodeToBase64`（maxDimension でリサイズ）

---

## Phase 2: Dot-by-Dot スクリーンショットモード

**変更ファイル:** `src/tools/screenshot.ts`

### 2-1. screenshotSchema に追加
```typescript
dotByDot: z.boolean().default(false).describe(
  "1:1 pixel mode (WebP). Image pixel = screen coordinate. Use for precise clicking."
),
webpQuality: z.number().int().min(1).max(100).default(60).describe(
  "WebP quality when dotByDot=true. 40=layout, 60=general, 80=fine text."
),
```

### 2-2. screenshotHandler 修正
- `dotByDot=true` の場合: `captureScreen(region, { format: "webp", webpQuality })`
- ウィンドウキャプチャ時、結果テキストにオフセット情報を付加:
  ```
  Screenshot (dot-by-dot): 976x618px | origin: (164, 78)
  → Image pixel (100, 50) = screen (264, 128)
  ```
- `dotByDot=false` の場合: 従来通り（PNG + maxDimension スケーリング）

### 2-3. トークンコスト分析
| モード | サイズ | トークン | 備考 |
|---|---|---|---|
| 現在 (768px PNG) | 768x432 | ~443 | スケール変換が必要 |
| dotByDot 全画面 | 1920x1080 | ~2,765 | 座標変換不要 |
| dotByDot ウィンドウ | ~1000x600 | ~800 | 最も実用的 |
| レイヤー差分（後述） | ~400x300 | ~160 | 変化部分のみ |

---

## Phase 3: ウィンドウレイヤーバッファ（RDP/MPEG 方式）

**新規ファイル:** `src/engine/layer-buffer.ts`

仮想デスクトップをウィンドウ単位のレイヤーとして管理。各レイヤーはウィンドウの「最後に送信したフレーム」を保持し、変化したレイヤーだけを再送信する。

### 3-1. データ構造
```typescript
interface WindowLayer {
  title: string;
  hwnd: bigint;                  // ウィンドウ識別子
  region: { x, y, width, height }; // スクリーン座標
  zOrder: number;
  rawPixels: Buffer;             // 最後のフレームの生ピクセル（RGBA）
  width: number;
  height: number;
  timestamp: number;             // 最後にキャプチャした時刻
}

interface LayerDiff {
  type: "unchanged" | "moved" | "content_changed" | "new" | "closed";
  title: string;
  region: { x, y, width, height };
  // content_changed の場合のみ画像を含む
  image?: { base64: string; mimeType: string; width: number; height: number };
  // moved の場合は旧座標
  previousRegion?: { x, y, width, height };
}

// モジュールレベルのシングルトン
const layers: Map<bigint, WindowLayer> = new Map();
```

### 3-2. コア関数

**`captureAndDiff(currentWindows): LayerDiff[]`**
1. 現在のウィンドウリストを受け取る
2. 各ウィンドウについて:
   - `layers` に存在しない → `type: "new"`、フレームをキャプチャしてバッファに格納
   - 位置が変わった → `type: "moved"`（画像は送らない。LLM は前のフレームを覚えている）
   - 位置同じ + ピクセル比較で変化あり → `type: "content_changed"`、新フレームを送信
   - 位置同じ + ピクセル変化なし → `type: "unchanged"`（何も送らない）
3. `layers` にあるが現在のリストにない → `type: "closed"`
4. ピクセル比較: ブロック単位（8x8）で平均色を比較、ノイズ閾値=16

**`clearLayers()`** - バッファ全クリア（I-frame 強制）

### 3-3. ピクセル比較の効率化
- 全ピクセル比較ではなく 8x8 ブロックの平均色で比較（1920x1080 → 240x135 = 32,400 比較で ~1ms）
- ウィンドウサイズ変更 = 自動的に content_changed
- 各レイヤーのメモリ: ~8MB（RGBA 1920x1080）。最大20ウィンドウでも ~160MB

### 3-4. screenshot ツールへの統合

**screenshotSchema に追加:**
```typescript
diffMode: z.boolean().default(false).describe(
  "Layer diff mode: compare with buffered frames, send only changed windows. " +
  "First call = full capture (I-frame). Subsequent = changed layers only (P-frame). " +
  "Implicitly enables dotByDot."
),
```

**diffMode=true の動作:**
1. 初回（バッファ空）: 全ウィンドウを 1:1 WebP でキャプチャ → バッファに格納 → 全画像を返す
2. 2回目以降:
   - `captureAndDiff()` を呼ぶ
   - レスポンスにテキストサマリ + 変化したウィンドウの画像のみ含める:
   ```
   Layer diff: 8 windows, 1 changed, 1 moved, 6 unchanged
   [CHANGED] "メモ帳" at (164,78) 976x618
   [MOVED]   "電卓" (990,431)→(500,200) (content same, no image)
   [UNCHANGED] "Chrome", "設定", ...
   ```
   - 画像は変化したウィンドウだけ（`content_changed` と `new`）

### 3-5. workspace_snapshot との連携

`workspace_snapshot` 既存の thumbnails を WebP レイヤーバッファからも取得可能にする:
- `workspace_snapshot` 呼び出し時にレイヤーバッファを初期化（I-frame として機能）
- 以降の `screenshot(diffMode=true)` は差分のみ
- ワークフロー例:
  ```
  workspace_snapshot → 全体把握（I-frame）
  focus_window("メモ帳") → ウィンドウ操作
  screenshot(diffMode=true) → メモ帳レイヤーだけ更新（P-frame、~800トークン）
  click_element(...) → UI操作
  screenshot(diffMode=true) → 変化レイヤーだけ更新（~160トークン）
  ```

---

## Phase 4: テキスト表現モード（画像→構造化テキスト変換）

画像ピクセルを送る代わりに、画面の状態をJSON/XMLで記述してトークンコストを劇的に削減。

### 4-1. ウィンドウのテキスト表現

各ウィンドウレイヤーを以下のような構造化テキストで表現:
```json
{
  "window": "メモ帳",
  "region": {"x": 164, "y": 78, "w": 976, "h": 618},
  "zOrder": 0,
  "elements": [
    {"type": "MenuBar", "items": ["ファイル", "編集", "表示"], "y": 120},
    {"type": "Document", "name": "テキスト エディター", "region": {"x":84,"y":153,"w":964,"h":505},
     "text": "Hello desktop-touch-mcp!\nset_element_value test OK"},
    {"type": "Button", "name": "設定", "region": {"x":1010,"y":120,"w":30,"h":32}},
    {"type": "StatusBar", "text": "行 1, 列 1 | 50 文字 | UTF-8"}
  ]
}
```

### 4-2. UIA テキスト表現の活用

`get_ui_elements` は既にこのデータを返せる。改善点:
- **ValuePattern のテキスト取得**: テキストフィールドの中身も含める（現在は要素名のみ）
- **座標付き**: 各要素の `boundingRect` がそのままクリック座標として使える
- **depth 制限の最適化**: テキスト表現用には depth=2-3 で十分

### 4-3. レイヤーバッファとの統合

レイヤーの状態を3段階で表現:
| レベル | 内容 | トークン | 用途 |
|---|---|---|---|
| **L0: メタデータ** | タイトル+座標+Z-order のみ | ~20/窓 | ウィンドウ配置確認 |
| **L1: テキスト表現** | UIA要素ツリー + テキスト値 | ~100-300/窓 | UI操作（ボタン名・入力欄の確認） |
| **L2: 画像** | WebP 1:1 ピクセル | ~800-2765/窓 | 視覚的確認が必要な場合のみ |

**`screenshot` ツールの `detail` パラメータ:**
```typescript
detail: z.enum(["meta", "text", "image"]).default("image").describe(
  "Response detail level. " +
  "'meta': window positions only (cheapest). " +
  "'text': UIA element tree with text values (recommended for UI interaction). " +
  "'image': actual screenshot pixels (use when visual check needed)."
),
```

### 4-4. 差分モードとの組み合わせ

`diffMode=true` + `detail="text"` の場合:
1. UIA テキスト表現をキャッシュ
2. 次回は変化した要素のみ報告:
```
Layer diff (text mode): "メモ帳" changed
  Document.text: "Hello..." → "Hello...\nnew line added"
  StatusBar: "行 1" → "行 2"
```
→ **~50 トークン** で画面変化を把握（画像の ~2765 トークン比 98% 削減）

### 4-5. ワークフロー例

```
1. workspace_snapshot(detail="text")    → 全ウィンドウの UIA テキスト表現（~1000 tok）
2. click_element("設定", ...)           → 設定ボタンをクリック
3. screenshot(diffMode=true, detail="text") → メモ帳の変化したUI要素だけ（~100 tok）
4. screenshot(detail="image", windowTitle="メモ帳") → 視覚確認が必要な時だけ画像（~800 tok）
```

従来: 毎回 screenshot(768px PNG) = ~443 tok × N回
提案: テキストベース = ~100 tok × N回 + 画像1回 = 大幅削減

---

## 実装順序

| ステップ | 内容 | ファイル |
|---|---|---|
| 1 | `CaptureResult` mimeType 拡張 + `encodeToWebP` 追加 | `src/engine/image.ts` |
| 2 | `CaptureOptions` 導入、キャプチャ関数のシグネチャ更新 | `src/engine/image.ts` |
| 3 | `dotByDot` + `webpQuality` パラメータ追加 | `src/tools/screenshot.ts` |
| 4 | ウィンドウオフセット情報をレスポンスに含める | `src/tools/screenshot.ts` |
| 5 | `layer-buffer.ts` 新規作成（レイヤー管理 + diff 計算） | `src/engine/layer-buffer.ts` |
| 6 | `diffMode` パラメータ追加 + ハンドラ実装 | `src/tools/screenshot.ts` |
| 7 | `detail` パラメータ追加（meta/text/image 3段階） | `src/tools/screenshot.ts` |
| 8 | UIA テキスト表現のキャッシュ + テキスト差分 | `src/engine/layer-buffer.ts` |
| 9 | `workspace_snapshot` のレイヤーバッファ初期化連携 | `src/tools/workspace.ts` |
| 10 | `screenshot_background` にも `dotByDot` 追加 | `src/tools/screenshot.ts` |

---

## 検証方法

### Phase 1-2 (WebP + dotByDot)
1. `screenshot(dotByDot=true)` → 画像サイズが画面解像度と一致、mimeType が `image/webp`
2. 画像内の座標でそのまま `mouse_click` → 正確にクリックされる
3. `screenshot(dotByDot=true, windowTitle="メモ帳")` → origin 情報がテキストに含まれる
4. WebP ファイルサイズが PNG 比で 60-80% 削減

### Phase 3 (レイヤー差分)
1. `screenshot(diffMode=true)` 初回 → 全ウィンドウ画像（I-frame）
2. 何も操作せず再度 `screenshot(diffMode=true)` → "0 changed" + 画像なし
3. メモ帳にテキスト入力 → `screenshot(diffMode=true)` → メモ帳レイヤーだけ更新
4. ウィンドウ移動 → 差分が "moved" として報告（画像なし）
5. 新規ウィンドウ起動 → "new" として報告 + 画像あり

### Phase 4 (テキスト表現)
1. `screenshot(detail="text", windowTitle="メモ帳")` → UIA ツリー JSON（画像なし）
2. `screenshot(detail="meta")` → 全ウィンドウのタイトル+座標のみ
3. `screenshot(diffMode=true, detail="text")` → テキスト差分のみ（~50 トークン）
4. テキスト表現に含まれる座標で `mouse_click` → 正確にクリック
