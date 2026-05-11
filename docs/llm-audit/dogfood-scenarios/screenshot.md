# Dogfood Scenarios — screenshot (PrintWindow default + BitBlt fallback)

- Status: **manual / dogfood scenarios** for the v1.4.4 PrintWindow-default capture flip
- Date: 2026-05-11
- Scope: `screenshot(detail='image', windowTitle / hwnd)` window-targeted captures and `screenshot(diffMode=true)` layer captures
- Why manual: the regressions this flip targets (RDP-session capture going black, GPU-composited apps coming back empty) are environment-dependent and not reproducible in CI. The unit tests in `tests/unit/screenshot-printwindow-default.test.ts` pin the routing decision (`isLikelyBlankCapture` / `captureWindowRawWithFallback`), but the actual "did PrintWindow recover the pixels that BitBlt was losing?" question can only be answered on a real RDP / GPU-composited host.

These scenarios run before each release that touches `src/engine/image.ts`, `src/engine/layer-buffer.ts`, or the `effectiveDetail === 'image'` branch of `src/tools/screenshot.ts`.

---

## 1. RDP session — GPU-composited app capture

**目的**: RDP セッション内で起動した Chrome (or other GPU-composited app) を `screenshot(detail='image', windowTitle='Chrome', confirmImage=true)` で撮ったとき、BitBlt path が黒/空を返していたのに対し PrintWindow path で実画像が取れることを確認する。

**前提**:
- ホスト A → RDP → ホスト B 接続
- ホスト B に desktop-touch-mcp を立ち上げる (RDP セッション側)
- Chrome / Edge / 任意の GPU-composited browser を任意の URL で起動

**手順**:
1. `screenshot({ detail: 'image', windowTitle: 'Chrome', confirmImage: true })` を呼ぶ
2. response の `hints.captureSource === 'printwindow'` (BitBlt fallback が走っていない) を確認
3. response の image 内容が実際の Chrome window 内容を映していることを目視確認

**期待**:
- `hints.captureSource === 'printwindow'`
- `hints.captureFallbackReason` フィールド無し
- `hints.warnings` に PrintWindow fallback 系の warning 無し
- 返却画像が黒/空ではなく実際の Chrome 内容

**Anti-pattern**: `hints.captureSource === 'bitblt-fallback'` + `hints.captureFallbackReason === 'printwindow-failed'` が出るのは PrintWindow native binding が壊れているシグナル。release blocker として扱う。

---

## 2. RDP session — `diffMode=true` layer capture

**目的**: layer buffer 経路 (`captureAndDiff`) も同じ PrintWindow + fallback 経路に乗っていることを確認する。RDP セッションで diff キャプチャを連続実行し、Chrome window が "new" / "content_changed" として image 付きで返ることを確認。

**手順**:
1. RDP セッション内で Chrome を起動 (任意 URL)
2. `screenshot({ diffMode: true, confirmImage: true })` を 1 回目 (I-frame、全 layer 取得)
3. Chrome 内でページ遷移 or scroll で content を変える
4. `screenshot({ diffMode: true })` を 2 回目 (P-frame)
5. 2 回目の response の Chrome layer が `[CHANGED]` で返り、image 内容が実 Chrome を映していることを目視確認

**期待**:
- 1 回目: Chrome を含む I-frame、各 layer に WebP image 添付
- 2 回目: Chrome が `content_changed` で image 添付、image 内容が変更後の Chrome 画面

**Anti-pattern**: 1 回目 / 2 回目どちらも Chrome layer が黒 → BitBlt path が選ばれてしまっている。PrintWindow native binding を疑う。

---

## 3. 空 Notepad — all-white regression pin

**目的**: 空 Notepad (all-white) を撮ったとき、`isLikelyBlankCapture` が誤って blank と判定して BitBlt fallback に流れない (= overlapping windows の絵を silent return しない) ことを確認する。これが本機能の最も重要な regression pin。

**前提**:
- 空 Notepad (本文無し、新規) を起動
- 他のなんらかの window (例: explorer) を Notepad の上に被せる (Notepad は部分的に隠れる)

**手順**:
1. `screenshot({ detail: 'image', windowTitle: 'メモ帳', confirmImage: true })` を呼ぶ
   - 英語環境では `windowTitle: 'Notepad'`
2. response の `hints.captureSource === 'printwindow'` を確認
3. response の image が **全白の Notepad 本文** であり、上に被っている explorer window が**写っていない**ことを目視確認

**期待**:
- `hints.captureSource === 'printwindow'`
- `hints.captureFallbackReason` 無し
- image は全白の Notepad (隠されている部分も含む全文白)

**Anti-pattern (release blocker)**:
- `hints.captureSource === 'bitblt-fallback'` → all-white 判定が誤発火している (`isLikelyBlankCapture` regression)
- image に explorer が映っている → fallback が走って on-screen rect の上書き layer を撮ってしまった

---

## 4. 全黒 terminal — all-black fallback warning shape

**目的**: 全黒の Windows Terminal (dark theme + 表示文字無し) を撮ったとき、`isLikelyBlankCapture` が all-black + zero variance を検出して BitBlt fallback に流すが、warning でユーザーが事故を疑える情報が返ることを確認する。

**手順**:
1. Windows Terminal を起動 + 表示文字を `clear` で消す (caret blink を待たないよう Terminal を非アクティブに)
2. `screenshot({ detail: 'image', windowTitle: 'Windows Terminal', confirmImage: true })` を呼ぶ
3. response の `hints.captureSource === 'bitblt-fallback'`、`hints.captureFallbackReason === 'printwindow-all-black'`、`hints.warnings[]` に「PrintWindow returned an all-black frame」固定文 warning が乗っていることを確認

**期待**:
- `hints.captureSource === 'bitblt-fallback'`
- `hints.captureFallbackReason === 'printwindow-all-black'`
- `hints.warnings[]` に上記 fixed-string warning

**Anti-pattern**: warning が乗らない / `mode='background'` への誘導 hint が無いと、利用者が「正しい黒い terminal」と「fallback された別 window」を区別できない。release blocker。

---

## 5. `mode='background'` 明示時の back-compat

**目的**: 明示的に `mode='background'` を渡したケースは flip 後も従来通り PrintWindow 経路に流れる (fallback ロジックは適用されない) ことを確認する。back-compat の保証。

**手順**:
1. `screenshot({ mode: 'background', windowTitle: 'Notepad', confirmImage: true })` (空 Notepad で all-white)
2. response が PrintWindow path で all-white を返し、fallback 関連の hints が無いことを確認

**期待**:
- 返却画像は all-white (Notepad 内容)
- `hints.captureSource` 系 hint は付かない (mode='background' は別ハンドラ `screenshotBgHandler` を経由するため新 hint surface 対象外)

---

## Release gate

これら 5 シナリオ全てが期待通りに通ることを確認するまで、`src/engine/image.ts` の capture pipeline を触った release は publish しない。手順は `docs/release-process.md` の smoke test 節と並走で実施。
