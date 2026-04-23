# Anti-Fukuwarai v2 — Dogfood Log

作成: 2026-04-23  
フェーズ: P4-E / Batch A（skeleton） → Batch B/C で実録

---

## 合格ライン（default-on 判定に使用）

以下 5 点を全て満たすと **v0.17.0 default-on 切替に進む**。1 点でも欠ければ v0.16.x patch で dogfood 継続。

1. **実録数**: 5 シナリオ全て記録済み（pass / fail 問わず）
2. **V2 単独 pass**: 5 シナリオのうち 3 つ以上が V1 fallback なしで完了
3. **Fallback 成功**: fail したシナリオ全てで V1 fallback が成功している
4. **Docs 整合**: warning / fail reason の意味が実録から読み取れ、tool description と矛盾しない
5. **安定性**: dogfood 期間中に crash / hang / session leak が **0 件**

**チェック状況:**
- [ ] S1 browser-form
- [ ] S2 browser-click
- [ ] S3 terminal
- [ ] S4 native-dialog
- [ ] S5 visual-only
- [ ] 合格ライン達成 → v0.17.0 切替可

---

## シナリオテンプレート

```markdown
## Scenario N: <short title>

- **date**: YYYY-MM-DD
- **version**: vX.Y.Z
- **target**: <app name or URL>
- **category**: browser-form | browser-click | terminal | native-dialog | visual-only
- **goal**: <1 line>

### Steps
| # | tool | args summary | result |
|---|---|---|---|
| 1 | desktop_see | target=... | entities: N, warnings: [...] |
| 2 | desktop_touch | entityId=... | ok: true, diff: [...] |

### Observations
- **round-trips**: N（desktop_see + desktop_touch のペア数）
- **warnings seen**: [no_provider_matched / partial_results_only / ...]
- **fail reasons seen**: [modal_blocking / executor_failed / ...]
- **fallback taken**: yes / no — （理由と使用した V1 tool）
- **user-facing friction**: <1-3 行>

### Verdict
- [ ] Passed without V1 fallback
- [ ] Passed with V1 fallback (acceptable)
- [ ] Failed — <root cause>
```

---

## Scenario 1: Browser Form — Issue タイトル入力

- **date**: TBD
- **version**: TBD
- **target**: GitHub Issues 新規作成ページ（または任意の webmail compose）
- **category**: browser-form
- **goal**: フォームの title / body フィールドに `desktop_see` + `desktop_touch` で入力し、V1 fallback なしで完了する

### Steps
<!-- 実録時に記入 -->

### Observations
<!-- 実録時に記入 -->

### Verdict
<!-- 実録時に記入 -->

---

## Scenario 2: Browser Click — Webmail Compose ボタン

- **date**: TBD
- **version**: TBD
- **target**: 任意の webmail（Gmail / Outlook Web 等）
- **category**: browser-click
- **goal**: Compose / 新規作成ボタンを `desktop_see` + `desktop_touch` でクリックし、作成ウィンドウが開くことを確認する

### Steps
<!-- 実録時に記入 -->

### Observations
<!-- 実録時に記入 -->

### Verdict
<!-- 実録時に記入 -->

---

## Scenario 3: Terminal — git status 送信

- **date**: TBD
- **version**: TBD
- **target**: Windows Terminal / cmd.exe
- **category**: terminal
- **goal**: `desktop_see` でターミナルを観測し、`desktop_touch` で `git status\n` を送信。フォアグラウンドウィンドウが変わらないことを確認（G2 WM_CHAR path 実動作確認）

### Steps
<!-- 実録時に記入 -->

### Observations
<!-- 実録時に記入 -->

### Verdict
<!-- 実録時に記入 -->

---

## Scenario 4: Native Dialog — 名前を付けて保存

- **date**: TBD
- **version**: TBD
- **target**: メモ帳等のネイティブアプリ → 名前を付けて保存ダイアログ
- **category**: native-dialog
- **goal**: `desktop_see` でダイアログの entity を観測し、ファイル名フィールドに入力して保存ボタンをクリック。modal guard（G1-A）の実動作を確認する

### Steps
<!-- 実録時に記入 -->

### Observations
<!-- 実録時に記入 -->

### Verdict
<!-- 実録時に記入 -->

---

## Scenario 5: Visual-Only — Electron アプリのカスタム描画領域

- **date**: TBD
- **version**: TBD
- **target**: UIA / CDP が効かないカスタム描画 UI を持つ Electron アプリ
- **category**: visual-only
- **goal**: `desktop_see` で visual lane のみで entity を取得し、`desktop_touch` でクリック。lease と visual lane の整合を確認する

### Steps
<!-- 実録時に記入 -->

### Observations
<!-- 実録時に記入 -->

### Verdict
<!-- 実録時に記入 -->

---

## 進捗サマリ

| # | シナリオ | 日付 | Verdict | V1 fallback |
|---|---|---|---|---|
| S1 | browser-form | TBD | - | - |
| S2 | browser-click | TBD | - | - |
| S3 | terminal | TBD | - | - |
| S4 | native-dialog | TBD | - | - |
| S5 | visual-only | TBD | - | - |
