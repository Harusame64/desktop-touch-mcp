# OCR 品質改善 実装計画書

**作成日**: 2026-04-24  
**最終更新**: 2026-04-24（フェーズ 1 実装完了）  
**対象**: desktop-touch-mcp-fukuwaraiv2 `ocr-bridge.ts` パイプラインの OCR 精度向上  
**スコープ**: 前処理強化（フェーズ 1）+ 後処理フィルター（フェーズ 2）  
**対象外**: Visual GPU lane 接続（PocVisualBackend 配線）、PaddleOCR/ONNX 導入、段階 3 Multi-engine フュージョン

---

## 実装状況（2026-04-24）

| フェーズ | 状態 | コミット範囲 |
|---|---|---|
| フェーズ 1: 前処理強化 | ✅ **実装完了・プッシュ済み** | `b0935eb`〜`9389846` |
| フェーズ 2: 後処理フィルター | ✅ **実装完了・プッシュ済み** | `97d9753`〜`967ffd4` |

### フェーズ 2 実装ログ（Opus レビューループで実施）

| # | コミット | ハッシュ | 備考 |
|---|---|---|---|
| 2-1 | C# に lineWordCount/lineCharCount 追加 | `97d9753` | Option A（生統計2フィールド）採用。Opus が lineScore 計算式の恒等式バグを指摘 |
| 2-2 | `calibrateOcrConfidence` + `hasGlyphConfusion` | `e8ff229` | Opus 修正4点（density閾値ガード、hasAscii判定、U+FFFD早期リターン、suggest閾値0.55）|
| 2-3 | `snapToDictionary`（Levenshtein 補正） | `e9ecb4b` | substring マッチ除去（Opus 指示）、tie-breaking 明文化、NFKC 全角→半角補正 |
| 2-4 | screenshot に辞書スナップ配線 | `b9eb9c0` | Opus が座標系の誤りを指摘（window-local vs screen-absolute）→ screen-absolute で統一 |
| 2-5 | compose-providers に OCR 第三レーン追加 | `80c14b9` | EntityLocator.ocr 追加不要（Opus 確認）、resolver 変更ゼロ、UIA-blind 時のみ起動 |
| 2-6 | golden テストに Phase 1+2 品質ゲート追加 | `967ffd4` | calibrateOcrConfidence と snapToDictionary を golden テストで検証 |

### フェーズ 1 実装ログ

| # | コミット | ハッシュ | 備考 |
|---|---|---|---|
| 1-1 | golden fixture ハーネス | `b0935eb` | integration テスト基盤、vitest に integration プロジェクト追加 |
| 1-2 | Rust scale 上限 4 + preprocessPolicy 型 | `d2093d2` | `node.lib` を node-gyp キャッシュからコピーして解決 |
| 1-3 | `decideEffectiveScale` 純関数 | `7210701` | 16 テスト all green |
| 1-4 | screenshot に preprocessPolicy 配線 | `04d66bb` + `c1ba9ba` | handler デフォルト値修正も含む（修正コミット）|
| 1-5 | Sauvola 適応二値化 Rust 実装 | `639ee74` | integral image、5 テスト all green |
| 1-6+7 | adaptive フラグ TS 全体配線 | `9389846` | 1-6 と 1-7 を一括コミット |

### ビルド環境補記

- Rust napi ビルド（`npm run build:rs`）には `node.lib` が必要。
  初回は `npx node-gyp install` でダウンロードし `C:\Users\<user>\AppData\Local\node-gyp\Cache\<version>\x64\node.lib` をプロジェクトルートにコピーしてから実行。
- `node.lib` は `.gitignore` 対象なのでリポジトリには含まれない。

### フェーズ 2 完了判定（実績）

- [x] `npm test`（TS）がローカルで green（93 ファイル・1673 件）
- [x] `tests/unit/ocr-calibrate.test.ts`（18 件）・`tests/unit/ocr-snap-dictionary.test.ts`（21 件）・`tests/unit/desktop-providers-ocr-lane.test.ts`（6 件）すべて green
- [ ] 実機 dogfood: Outlook PWA で `"FANUC"`・`"CUSCNET-SUPPORT"` 等の誤認識例が正しい綴りに戻ることを確認（fixture PNG 未生成のため未検証）
- [ ] Notepad 等の UIA 正常ターゲットで OCR lane が起動しないことをログで確認（未実施）

### フェーズ 1 完了判定（実績）

- [x] `cargo test`（Rust）/ `npm test`（TS）がローカルで green（90 ファイル・1624 件）
- [x] 既存 `tests/unit/ocr-bridge.test.ts`、`tests/unit/screenshot-ocr-path.test.ts` が green
- [ ] `tests/integration/ocr-golden.test.ts` で `preprocessPolicy="aggressive"` + `adaptive=true` 有効時に `known-broken` が baseline 比 **-15% 以上** 減少（fixture PNG 未生成のため未検証）
- [ ] 4K モニタ（3840×2160、200% DPI）での pipeline 時間測定（未実施）

---

## 背景・動機

Outlook PWA など sparse-UIA ターゲットで `desktop_see` が `visual_attempted_empty` を返す問題を調査した結果、Visual GPU backend は `PocVisualBackend`（stub）のためデータプレーン未接続であることが判明。OCR フォールバックは機能しているが誤認識が多い。

### 実測した OCR 品質の問題（Outlook PWA）

- `"FANUC"` → 部分欠損
- `"CUSCNET-SUPPORT"` → `"こ一DUCNET-SIJPPORT"`（I↔1、O↔0 混在、全角文字化け）
- 全体で 112 件取得できているが、誤認識・破損が散見される

### 現状 OCR パイプラインの構造

```
screenshot(ocrFallback=always)
  → runSomPipeline() / recognizeWindow()
    → PrintWindow(PW_RENDERFULLCONTENT) でキャプチャ
    → Rust: upscale_grayscale_contrast (scale=2, BT.601 + bilinear + min-max stretch)
    → win-ocr.exe (Windows.Media.Ocr) → OcrWord[] JSON
    → ocrWordsToActionable() (confidence 固定 0.7)
  → elements[] (112 件、誤認識あり)
```

### 信頼度プレースホルダの現状

`ocr-bridge.ts` の `ocrWordsToActionable()` では `confidence = 0.7` 固定で、単一文字・制御文字・U+FFFD のみ判定している。

---

## フェーズ 1: 前処理強化

### ゴール

- **Outcome-A**: 小フォント（物理 < 14px）でも文字の輪郭が潰れない（scale 引き上げポリシー）
- **Outcome-B**: 低コントラスト領域（Outlook の薄いツールバー等）での誤認識を減らす（局所適応二値化）
- 各コミットは単独で build & test がグリーンになる単位

### コミット一覧

---

#### ✅ commit 1-1 (`b0935eb`): `test(ocr-bridge): add golden fixture harness for OCR preprocessing regression`

- **ファイル**:
  - 新規 `tests/fixtures/ocr/README.md`（fixture の起源と再収集手順）
  - 新規 `tests/fixtures/ocr/outlook-fanuc.png`（Outlook PWA の sparse 画面サブ領域、PNG 400KB 以内）
  - 新規 `tests/fixtures/ocr/expected.json`（現状出力と正解のペア。`"CUSCNET-SUPPORT"` を期待値、`"こ一DUCNET-SIJPPORT"` を現状出力として併記）
  - 新規 `tests/integration/ocr-golden.test.ts`（`RUN_OCR_GOLDEN=1` 環境変数でのみ実行、通常 CI ではスキップ）
- **変更内容**: 計画全体の品質ゲートになる golden 比較基盤を先に整備する。`known-correct` / `known-broken` の 2 リストを JSON に持つ薄いハーネス。以降のコミットが改善量を数値で示せるようにする
- **テスト**: 上記テストそのもの。初回ローカル実行で `expected.json` を生成する snapshot フロー
- **想定時間**: 1.5h（fixture 収集・JSON 生成込み）
- **TS/Rust/C# の区分**: TS のみ

---

#### ✅ commit 1-2 (`d2093d2`): `feat(image_processing): expose scale=1..4 and wire from TS (Rust)`

- **ファイル**:
  - `src/image_processing.rs:57-70`（`upscale_grayscale_contrast` 入力検証）— `opts.scale > 3` ガードを `> 4` に緩和
  - `src/engine/native-types.ts` — `NativePreprocessOptions.scale` JSDoc を「2 or 3」→「1..4」に更新
  - `src/engine/ocr-bridge.ts:393-458`（`runSomPipeline` シグネチャ）— `preprocessPolicy` 引数を追加（`"auto" | "aggressive" | "minimal"`、デフォルト `"auto"` で現状互換）
- **変更内容**: Rust 側の scale 上限を 4 に広げる能力追加のみ。デフォルトは不変
- **テスト**:
  - 新規 `tests/unit/preprocess-scale.test.ts` — 4×4 RGBA buffer に scale=3, 4 をかけ出力サイズを検証（native モジュール不在時は `test.skipIf(!nativeEngine)`）
- **想定時間**: 1.5h（Rust ビルド・`index.d.ts` 再生成込み）
- **TS/Rust/C# の区分**: **Rust 変更あり**（`cargo build --release` + `npm run build` 必要）+ TS 型 JSDoc

---

#### ✅ commit 1-3 (`7210701`): `feat(ocr-bridge): introduce preprocessPolicy to control scale selection`

- **ファイル**: `src/engine/ocr-bridge.ts:393-458`
  - `runSomPipeline` に `preprocessPolicy?: "auto" | "aggressive" | "minimal"` 追加
  - `effectiveScale` 決定ロジックを `decideEffectiveScale(policy, baseScale, megapixels, windowDpi)` として切り出し
  - ルール:
    - `"minimal"`: 常に scale=1
    - `"auto"`: 現状ロジック踏襲（OOM 8MP → 1、DPI ≥ 144 → 1、それ以外 baseScale）
    - `"aggressive"`: DPI クランプを 144 → 168 に緩和（150% DPI まで upscale、175% 以上は放棄）。OOM 閾値は 8MP 固定
- **変更内容**: Outlook PWA の実測（DPI 1.5x = 144、100% 相当の文字が薄い）で aggressive が効く
- **テスト**:
  - 新規 `tests/unit/preprocess-policy.test.ts` — `decideEffectiveScale` を export して純関数テスト（3 policy × {96, 144, 168, 192 dpi} × {4MP, 10MP} のマトリクス）
- **想定時間**: 1.0h
- **TS/Rust/C# の区分**: TS のみ

---

#### ✅ commit 1-4 (`04d66bb` + `c1ba9ba`): `feat(screenshot): surface preprocessPolicy through screenshot tool`

- **ファイル**:
  - `src/tools/screenshot.ts:130-143`（`screenshotSchema`）— `preprocessPolicy: z.enum(["auto","aggressive","minimal"]).default("auto")` を追加
  - `src/tools/screenshot.ts:369-409`（`detail === "som"` ブロック）— `runSomPipeline` 呼び出しに `preprocessPolicy` を伝搬
  - `src/tools/screenshot.ts:607-647`（SoM モード OCR フォールバック経路）— 同上
  - compose-providers への配線は commit 2-4 で追加（本コミットは screenshot 側のみ）
- **変更内容**: 呼び出し側から policy を指定できる薄い配線。デフォルト `"auto"` で現状互換
- **テスト**: `tests/unit/screenshot-ocr-path.test.ts` に `preprocessPolicy` ケースを 2-3 件追加（schema パース + handler 呼び出しモック）
- **想定時間**: 0.5h
- **TS/Rust/C# の区分**: TS のみ

---

#### ✅ commit 1-5 (`639ee74`): `feat(image_processing): add adaptive binarization (Sauvola) in Rust`

- **ファイル**:
  - `src/image_processing.rs` — `minmax_stretch_u8` の下に `sauvola_binarize_u8(src, w, h, window=15, k=0.2) -> Vec<u8>` を新規追加（integral image ベースで O(wh)）
  - 同ファイル `upscale_grayscale_contrast` に `PreprocessOptions.adaptive?: bool` を追加（`Some(true)` のときのみ min-max stretch 後段で Sauvola を適用し 0/255 二値画像を返す）
  - `src/engine/native-types.ts` — `NativePreprocessOptions.adaptive?: boolean` を追加
- **変更内容**: Sauvola は Niblack 派生の局所適応二値化で、低コントラスト背景 + 細字に強い（OCR 文献で定番）。integral image なので 5K 画像でも 50ms 以下の想定
- **テスト**:
  - 新規 `tests/unit/preprocess-sauvola.test.ts` — グラデーション背景 + 薄い文字矩形の合成画像を使い、`adaptive=false` では矩形が消えるが `adaptive=true` では 0/255 で分離されることをピクセルカウントで検証
- **想定時間**: 3.0h（Sauvola 実装 + integral image のバグ取りを慎重に）
- **TS/Rust/C# の区分**: **Rust 中心**（約 120 行）+ TS 型追加のみ。**Rust リビルド必要**

---

#### ✅ commit 1-6 (`9389846`): `feat(ocr-bridge): thread adaptive flag through runSomPipeline`

- **ファイル**:
  - `src/engine/ocr-bridge.ts:393-500` — `runSomPipeline` に `adaptive?: boolean` 引数追加（デフォルト `false` で現状互換）。`preprocessImage` 呼び出しに渡す
  - sharp フォールバック経路（`ocr-bridge.ts:477-487`）は `adaptive=true` のとき warning ログを出して適用せず続行（sharp で Sauvola は重いため Rust 経路限定）
  - `preprocessPolicy` との連動: `"aggressive"` のとき `adaptive` を常に `true` にプロモート
- **変更内容**: commit 1-5 の機能を TS から使えるようにする配線
- **テスト**: `tests/integration/ocr-golden.test.ts` に `adaptive=true` / `"aggressive"` を追加し、broken 比率が下がることを assertion
- **想定時間**: 1.0h
- **TS/Rust/C# の区分**: TS のみ（Rust は 1-5 完了済み）

---

#### ✅ commit 1-7 (`9389846` と同一コミット): `feat(screenshot): expose adaptive flag and update docs`

- **ファイル**:
  - `src/tools/screenshot.ts:130-143` — `preprocessAdaptive: z.boolean().default(false)` を追加
  - `screenshotHandler` で `runSomPipeline` に伝搬
  - `docs/system-overview.md` に「OCR 前処理ポリシー」セクションを追加
- **変更内容**: `screenshot({detail: "som", preprocessAdaptive: true, preprocessPolicy: "aggressive"})` を外部から呼べるようにする仕上げ
- **テスト**: `tests/unit/screenshot-ocr-path.test.ts` に schema assertion を 1 件追加
- **想定時間**: 0.5h
- **TS/Rust/C# の区分**: TS のみ

---

### フェーズ 1 合計: 約 9 時間

### フェーズ 1 完了判定
- [ ] `tests/integration/ocr-golden.test.ts` で `preprocessPolicy="aggressive"` + `adaptive=true` 有効時に `known-broken` が baseline 比 **-15% 以上** 減少
- [ ] 既存 `tests/unit/ocr-bridge.test.ts`、`tests/unit/screenshot-ocr-path.test.ts` が green
- [ ] `cargo test`（Rust）/ `npm test`（TS）がローカルで green
- [ ] 4K モニタ（3840×2160、200% DPI）で `runSomPipeline` の total pipeline 時間が現状比 +30% 以内

---

## フェーズ 2: 後処理フィルター

### ゴール

- **Outcome-C**: `ocrWordsToActionable` の confidence が、プレースホルダから「入力テキストの文字種分布 + UIA 辞書一致度」ベースの値に
- **Outcome-D**: 破損語が UIA name に一致・近似するとき `actionable.name` が UIA 側の綴りに**置換**される
- **Outcome-E**: compose-providers の merge 段階で OCR 候補が UIA 候補と自然に dedupe される

### コミット一覧

---

#### commit 2-1: `feat(win-ocr): surface line coverage score from C# binary`

- **ファイル**:
  - `tools/win-ocr/WinOcr.cs:63-83` — WinRT `OcrWord` は word-level confidence を公式 API で提供しない。代替として `lineMatchScore`（各 `OcrLine.Text` と `Word.Text` の文字被覆率）を近似スコアとして JSON に追加
  - 出力 JSON フィールド: `{text, bbox, lineScore?}`（後方互換: 既存 client は `lineScore` を無視）
  - `src/engine/ocr-bridge.ts:15-19`（`OcrWord` 型）— `lineScore?: number` を追加し `runOcr` でパースして透過的に渡す
- **変更内容**: WinRT.Ocr が word-level confidence を持たないため、line 被覆率を近似スコアとして導出。後段の信頼度キャリブレーションのベースになる
- **テスト**:
  - `tests/unit/ocr-bridge.test.ts` に `lineScore` がパイプライン末端まで伝搬することを確認する minimal な assertion を追加（mock `runOcr` 出力使用）
  - C# 側のユニットテストは追加しない（dotnet publish が CI コスト高）。代わりに `tools/win-ocr/README.md` に heuristic の定義を明記
- **想定時間**: 2.0h（C# publish + バイナリ差し替え確認込み）
- **TS/Rust/C# の区分**: **C# 変更あり**（`dotnet publish -c Release` の再ビルドが必要）+ TS 型追加

---

#### commit 2-2: `feat(ocr-bridge): replace confidence placeholder with calibrated score`

- **ファイル**: `src/engine/ocr-bridge.ts:273-313`（`ocrWordsToActionable`）
  - 現状の固定値を純関数 `calibrateOcrConfidence(word: OcrWord): number` に差し替え
  - 算式:
    1. `base = word.lineScore ?? 0.7`
    2. 文字種ペナルティ: 単一文字 ×0.85、ASCII 短語（長さ 2-3）×0.9、U+FFFD 含む ×0.3、CJK 互換/制御 ×0.6
    3. サイズペナルティ: `bbox.height < 10px` → ×0.8
    4. Glyph confusion ペナルティ（新規）: `hasGlyphConfusion(t)` が true なら ×0.7。判定対象: `I↔1`・`O↔0` 混在、全角ハイフン `一` がラテン語彙に混入など（Outlook の実測ケースを直接ターゲット）
    5. `clamp(result, 0, 1)` → 小数第 2 位で round
- **変更内容**: プレースホルダを「line 被覆率 × 文字種ペナルティ × glyph 混同ペナルティ」の積に置換
- **テスト**:
  - 新規 `tests/unit/ocr-calibrate.test.ts`（15 ケース程度）:
    - `"Send"` → ≥ 0.85
    - `"こ一DUCNET-SIJPPORT"` → ≤ 0.5
    - `"FANUC"`（lineScore 低）→ 0.6 台
    - U+FFFD、単一文字、小 bbox の単独効果
- **想定時間**: 2.0h
- **TS/Rust/C# の区分**: TS のみ

---

#### commit 2-3: `feat(ocr-bridge): add UIA-dictionary snap-correction`

- **ファイル**: `src/engine/ocr-bridge.ts` — 新規 export:
  ```ts
  export interface OcrDictionaryEntry { label: string; rect?: Rect; }
  export function snapToDictionary(
    words: OcrWord[],
    dictionary: OcrDictionaryEntry[],
    opts?: { maxDistance?: number; localityPx?: number }
  ): OcrWord[]
  ```
  - アルゴリズム:
    1. 辞書エントリの `label` を NFKC + 大小統一で正規化
    2. 各 OCR word に対し:
       - 完全一致 → そのまま返す
       - 部分一致（substring, case-insensitive）→ 辞書 label で text を置換（rect はそのまま）
       - Levenshtein 距離 ≤ `maxDistance`（default = `min(2, ⌈len×0.2⌉)`）かつ locality 内（`bbox` 中心距離 ≤ `localityPx`、default 200px）→ 置換
       - いずれも非該当 → 元の word を返す
    3. 返す word に `_correctedFrom?: string` を付加（デバッグ用）
  - Levenshtein は素朴実装（dictionary は数百エントリ、word も数百 → 10^5 比較で実用的）
- **変更内容**: 破損 OCR を UIA 辞書に寄せる純関数。`CUSCNET-SUPPORT` が UIA tree に存在すれば確実に救済される
- **テスト**:
  - 新規 `tests/unit/ocr-snap-dictionary.test.ts`（主要ケース）:
    - `"こ一DUCNET-SIJPPORT"` + dict `[{label: "CUSCNET-SUPPORT"}]` → snap される
    - Levenshtein 距離 3 以上は snap されない
    - locality 外は snap されない
    - 空辞書・空入力の safe behavior
- **想定時間**: 2.5h
- **TS/Rust/C# の区分**: TS のみ

---

#### commit 2-4: `feat(screenshot): build OCR dictionary from UIA candidates and apply snap`

- **ファイル**:
  - `src/tools/screenshot.ts:599-668`（OCR フォールバック経路）:
    - UIA result が使える場合に辞書を構築:
      ```ts
      const uiaDict: OcrDictionaryEntry[] = (raw?.elements ?? [])
        .filter(e => e.name && e.name.length >= 2)
        .map(e => ({ label: e.name, rect: e.boundingRect }));
      ```
    - `runSomPipeline` / `recognizeWindow` の出力 words に `snapToDictionary(words, uiaDict)` を適用してから `ocrWordsToActionable` に渡す
  - `src/tools/screenshot.ts:649-668`（plain OCR 経路）— 同様に適用
  - `runSomPipeline` シグネチャに `dictionary?: OcrDictionaryEntry[]` を追加（undefined のとき何もしない）
  - 辞書は UI レイヤで構築し `runSomPipeline` に渡す設計（関心分離）
- **注意点**: OCR 側の座標系（screen-absolute vs window-local）を揃えてから `snapToDictionary` に渡すこと
- **テスト**:
  - `tests/integration/ocr-golden.test.ts` に「UIA dict を与えた場合」の列を追加し broken 比率が 2-3 ポイント下がることを確認
  - 新規 `tests/unit/screenshot-ocr-dict-integration.test.ts` — mock UIA + mock OCR を与え、snap 後の `actionable.name` が UIA 側の綴りに一致することを確認
- **想定時間**: 2.0h
- **TS/Rust/C# の区分**: TS のみ

---

#### commit 2-5: `feat(compose-providers): integrate OCR candidates as additive lane on blind targets`

- **ファイル**:
  - 新規 `src/tools/desktop-providers/ocr-provider.ts`（`fetchOcrCandidates(target, dictionary): Promise<ProviderResult>`）:
    - 内部で `runSomPipeline` を呼び、returned elements を `UiEntityCandidate` に mapping（`source: "ocr"`, `confidence: calibrateOcrConfidence(...)`）
    - dictionary で snap された候補は `sourceId` に元の破損 text を残し、`label` は snap 後の値
  - `src/tools/desktop-providers/compose-providers.ts:269-287`（native window ルート）:
    - UIA 結果の warning に `uia_blind_*` が含まれる場合のみ、UIA 候補の labels を辞書化して `fetchOcrCandidates(target, dict)` を追加
    - 既存 visual lane と**並列**に走らせ `mergeResults([uiaResult, visualResult, ocrResult])` で吸収
    - UIA 正常ターゲット（Notepad 等）では OCR lane を起動しない（性能・ノイズ防止）
    - OCR も empty の場合 `ocr_attempted_empty` warning を追加（新規）
  - 既存 `resolver.ts` の dedup（digest + rect）はそのまま利用
- **変更内容**: OCR を compose-providers の第三レーンとして格上げ。blind 判定時のみ起動
- **テスト**:
  - 新規 `tests/unit/desktop-providers-ocr-lane.test.ts`:
    - UIA blind + OCR が候補返す → merged に OCR 候補が入る
    - UIA 正常 → `fetchOcrCandidates` が呼ばれない
    - UIA blind + OCR 空 → `ocr_attempted_empty` warning
  - 既存 `tests/unit/desktop-providers.test.ts` のマージ不変性テストが green のまま
- **想定時間**: 3.0h
- **TS/Rust/C# の区分**: TS のみ

---

#### commit 2-6: `test(integration): end-to-end quality regression gate with Outlook-like fixture`

- **ファイル**: `tests/integration/ocr-golden.test.ts`（commit 1-1 で作成）に最終 enforcement を追加:
  - `scale=1, adaptive=false, dict=[]` → baseline（現状と同等）
  - `scale=2, adaptive=true, dict=[]` → broken 比率が baseline 比 -15% 以上改善
  - `scale=2, adaptive=true, dict=uiaDict` → broken 比率が baseline 比 -30% 以上改善
  - `RUN_OCR_GOLDEN=1` 環境変数でのみ実行
- **変更内容**: フェーズ 1+2 のリリース判定ゲート。改善量を数値で保証する
- **テスト**: 自身
- **想定時間**: 1.0h
- **TS/Rust/C# の区分**: TS のみ

---

### フェーズ 2 合計: 約 12.5 時間

### フェーズ 2 完了判定
- [ ] `tests/integration/ocr-golden.test.ts` で UIA dict ありのとき `known-broken` が baseline 比 **-30% 以上** 減少
- [ ] `tests/unit/ocr-calibrate.test.ts`、`tests/unit/ocr-snap-dictionary.test.ts`、`tests/unit/desktop-providers-ocr-lane.test.ts` すべて green
- [ ] 実機 dogfood: Outlook PWA で `"FANUC"`・`"CUSCNET-SUPPORT"` 等の誤認識例が `actionable[].name` で正しい綴りに戻ることを 1 件以上確認
- [ ] Notepad 等の UIA 正常ターゲットで OCR lane が**起動しない**ことをログで確認（余計なコスト増がない）

---

## リスクと注意点

| # | リスク | 対処 |
|---|---|---|
| R1 | C# バイナリ再配布 | commit 2-1 で `dotnet publish` 後に `bin/win-ocr.exe` を差し替え。PR レビュー時にバイナリサイズ差分を説明 |
| R2 | Rust ビルド環境 | commit 1-2・1-5 は `cargo build --release` + napi index 再生成必須。CI で `index.node` が古いと silent に sharp 経路にフォールバックするため `native-engine.ts:166-171` のロードログで検出可能 |
| R3 | Sauvola の副作用 | 二値化で bbox が過剰に太くなる可能性。commit 1-5 で sanity テストし、cluster 精度が下がる場合は `adaptive` をオプトイン（default false）で留める |
| R4 | 辞書スナップの過剰適用 | 短い UIA name（2-3 文字）+ 緩い距離で誤 snap の懸念。`maxDistance = min(2, ⌈len×0.2⌉)` と `label 長 ≥ 2` の制約を commit 2-3・2-4 で徹底 |
| R5 | 座標系の不一致 | OCR の座標系（screen-absolute vs window-local）と UIA 辞書 rect を統一してから `snapToDictionary` に渡すこと（commit 2-4 で明示） |
| R6 | OCR lane の性能コスト | blind ターゲットで UIA + visual + OCR の 3 lane 並列起動になる。`runSomPipeline` は数百ms〜1s 級。必要なら `ocr_lane_budget_ms` を env flag で付ける余地を残す |
| R7 | Golden fixture の再現性 | 時間経過で Outlook 画面が変わっても OCR テストは画像ピクセルしか見ないため影響なし。fixture 差し替え時は `expected.json` の `known-correct` / `known-broken` も同時更新 |

---

## 関連ファイル（読解済み）

| ファイル | 役割 |
|---|---|
| `src/engine/ocr-bridge.ts` | OCR パイプライン全体（主要変更対象） |
| `src/engine/image.ts` | 画像前処理（PrintWindow キャプチャ） |
| `src/engine/win32.ts` | PrintWindow 実装（`PW_RENDERFULLCONTENT`） |
| `src/engine/native-engine.ts` | Rust native module ロード |
| `src/image_processing.rs` | Rust 前処理実装（upscale・二値化） |
| `src/tools/screenshot.ts` | screenshot tool・SoM/OCR フォールバック発火 |
| `src/tools/desktop-providers/compose-providers.ts` | UIA / visual lane 合成（OCR lane 追加対象） |
| `src/tools/desktop-providers/uia-provider.ts` | UIA 候補取得（辞書ソース） |
| `tools/win-ocr/WinOcr.cs` | Windows.Media.Ocr ラッパー（C#） |
| `tests/unit/ocr-bridge.test.ts` | 既存 OCR ユニットテスト |
| `tests/unit/screenshot-ocr-path.test.ts` | OCR フォールバック発火ロジックテスト |

---

## フェーズ独立性

- フェーズ 1 と フェーズ 2 は**独立 PR** としてリリース可能（commit 1-7 時点と commit 2-6 時点それぞれで `feat(ocr): ...` PR としてマージ可）
- H5〜H7 ハードニングとはコード的衝突は想定されない（`compose-providers.ts` への lane 追加のみが同ファイルに触れる点だけ注意）
