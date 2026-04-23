# Anti-Fukuwarai v2 — Dogfood Log

作成: 2026-04-23  
フェーズ: P4-E / Batch A（skeleton）→ Batch B（実装）→ Batch C（実録・判定）

---

## 判定フロー（Tier 1 / Tier 2）

| 層 | 担当 | 内容 | 結果の意味 |
|---|---|---|---|
| **Tier 1** | Claude | 静的コード確認 + HTTP 実機確認 | v0.17.0 default-on の「コード準備完了」 |
| **Tier 2** | ユーザー | 5 シナリオ実録（本 log） | v0.17.0 release tag + publish 許可 |

**Tier 1 は完了済み（✅）。Tier 2（実録）完了まで release しない。**  
詳細: [`anti-fukuwarai-v2-batch-c-tier1-review.md`](anti-fukuwarai-v2-batch-c-tier1-review.md)

---

## Tier 1 チェックサマリ（参考）

| チェック | 結果 |
|---|---|
| 350 unit tests pass | ✅ |
| HTTP preflight 6/6, 60 tools（default-on） | ✅ |
| DISABLE=1 で 58 tools（kill switch 動作） | ✅ |
| G1 modal/viewport/focus wiring 実接続 | ✅ |
| G2 terminal WM_CHAR background path | ✅ |
| G4 visual attach retry（両警告・1 回・全ブランチ） | ✅ |
| warning/fail reason enum: docs と完全一致（14 コード） | ✅ |

---

## 合格ライン（Tier 2 / default-on release 判定）

以下 5 点を全て満たすと **v0.17.0 default-on 切替 release に進む**。1 点でも欠ければ v0.16.x patch で dogfood 継続。

1. **実録数**: 5 シナリオ全て記録済み（pass / fail 問わず）
2. **V2 単独 pass**: 5 シナリオのうち 3 つ以上が「V1 fallback なし」または「V1 fallback が 1 回以内で完了」
3. **Fallback 成功**: fail したシナリオ全てで V1 fallback が成功している
4. **Docs 整合**: warning / fail reason の意味が実録から読み取れ、tool description と矛盾しない（T7 の enum 一致は確認済み）
5. **安定性**: dogfood 期間中に crash / hang / session leak が **0 件**

**チェック状況（Tier 2）:**
- [ ] S1 browser-form
- [ ] S2 browser-click
- [ ] S3 terminal
- [ ] S4 native-dialog
- [ ] S5 visual-only
- [ ] 合格ライン 5 点達成 → v0.17.0 release 実行可

---

## 事前準備（実録前に確認）

```
1. Claude Desktop で desktop-touch-mcp が接続されていること
2. DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2 が設定されていないこと（default-on）
3. tools/list に desktop_see と desktop_touch が含まれること（計 60 tools）
4. S1/S2: Chrome/Edge を --remote-debugging-port=9222 付きで起動しておく
5. S3: Windows Terminal / Git Bash 等が開いていること
4. S4: メモ帳等のネイティブアプリが開いていること
5. S5: Electron アプリ（VS Code / Discord / Slack 等）が開いていること
```

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
- **version**: TBD（v0.16.x を使用）
- **target**: GitHub Issues 新規作成ページ（または任意のブラウザフォーム）
- **category**: browser-form
- **goal**: フォームの title / body フィールドに `desktop_see` + `desktop_touch` で入力し、V1 fallback なしで完了する

**実録手順:**
1. Chrome/Edge を `--remote-debugging-port=9222` で起動し GitHub Issue 作成ページを開く
2. `desktop_see` を `target: { tabId: <cdp tab id> }` で呼ぶ
3. title フィールドの entity を確認（`type: "input"` など）
4. `desktop_touch` で lease を渡して `action: "input"`, `text: "test title"` を実行
5. `ok: true` / warnings / diff を記録
6. body フィールドも同様に実行

**確認ポイント:**
- CDP lane が使われているか（`sources` に `cdp` があるか）
- `visual_provider_warming` / `visual_provider_unavailable` が出た場合、retry 後に解消するか
- `entity_outside_viewport` が出る場合は scroll してから retry

### Steps
<!-- 実録時に記入（上記手順に従う） -->

### Observations
<!-- 実録時に記入 -->
- **round-trips**: 
- **warnings seen**: 
- **fail reasons seen**: 
- **fallback taken**: 
- **user-facing friction**: 

### Verdict
- [ ] Passed without V1 fallback
- [ ] Passed with V1 fallback (acceptable)
- [ ] Failed — <root cause>

---

## Scenario 2: Browser Click — Webmail Compose ボタン

- **date**: TBD
- **version**: TBD（v0.16.x を使用）
- **target**: Gmail / Outlook Web 等の webmail
- **category**: browser-click
- **goal**: Compose / 新規作成ボタンを `desktop_see` + `desktop_touch` でクリックし、作成ウィンドウが開くことを確認する

**実録手順:**
1. Chrome/Edge で webmail を開く（CDP 接続済み）
2. `desktop_see` で Compose / 新規作成ボタンを含む entity を取得
3. `desktop_touch` で `action: "click"` を実行
4. `diff` に `modal_appeared` / `focus_shifted` が含まれるか確認

**確認ポイント:**
- CDP selector を使う Priority 1（`browser_click_element`）との比較
- `desktop_touch` でも同等に動作するか（Priority 2 の機能確認）
- lease の期限内に実行できているか（round-trip が短いか）

### Steps
<!-- 実録時に記入 -->

### Observations
<!-- 実録時に記入 -->
- **round-trips**: 
- **warnings seen**: 
- **fail reasons seen**: 
- **fallback taken**: 
- **user-facing friction**: 

### Verdict
- [ ] Passed without V1 fallback
- [ ] Passed with V1 fallback (acceptable)
- [ ] Failed — <root cause>

---

## Scenario 3: Terminal — git status 送信

- **date**: TBD
- **version**: TBD（v0.16.x を使用）
- **target**: Windows Terminal / Git Bash / cmd.exe
- **category**: terminal
- **goal**: `desktop_see` でターミナルを観測し、`desktop_touch` で `git status\n` を送信。フォアグラウンドウィンドウが変わらないことを確認（G2 WM_CHAR path 実動作）

**実録手順:**
1. Windows Terminal を開いてリポジトリのディレクトリに移動しておく
2. 別ウィンドウ（例: メモ帳）をフォアグラウンドにしておく
3. `desktop_see` を `target: { windowTitle: "Terminal" }` 等で呼ぶ
4. ターミナル入力エリアの entity を確認
5. `desktop_touch` で `action: "input"`, `text: "git status\n"` を実行
6. ターミナルにコマンドが入力されたか、フォアグラウンドウィンドウが変わらないかを確認

**確認ポイント:**
- `terminal` lane の entity が取れているか
- `executor_failed` が出た場合: WM_CHAR が非サポートのターミナルか確認
- フォアグラウンドウィンドウが奪われていないか（G2 確認）

### Steps
<!-- 実録時に記入 -->

### Observations
<!-- 実録時に記入 -->
- **round-trips**: 
- **warnings seen**: 
- **fail reasons seen**: 
- **fallback taken**: 
- **user-facing friction**: 

### Verdict
- [ ] Passed without V1 fallback
- [ ] Passed with V1 fallback (acceptable)
- [ ] Failed — <root cause>

---

## Scenario 4: Native Dialog — 名前を付けて保存

- **date**: TBD
- **version**: TBD（v0.16.x を使用）
- **target**: メモ帳（notepad.exe）→ ファイル → 名前を付けて保存
- **category**: native-dialog
- **goal**: `desktop_see` でダイアログの entity を観測し、ファイル名フィールドに入力して保存ボタンをクリック。modal guard（G1, §9）の実動作を確認する

**実録手順:**
1. メモ帳を開き、ファイル → 名前を付けて保存 でダイアログを開く
2. `desktop_see` を `target: { windowTitle: "名前を付けて保存" }` 等で呼ぶ
3. ファイル名フィールド、保存ボタンの entity を確認
4. `desktop_touch` でファイル名フィールドに入力
5. `desktop_touch` で保存ボタンをクリック

**確認ポイント:**
- `modal_blocking` が出る場合は別のモーダルが前面にある（G1-A 動作確認）
- `entity_outside_viewport` が出る場合はダイアログが画面外（G1-B 動作確認）
- UIA lane で dialog entity が正しく取れているか

### Steps
<!-- 実録時に記入 -->

### Observations
<!-- 実録時に記入 -->
- **round-trips**: 
- **warnings seen**: 
- **fail reasons seen**: 
- **fallback taken**: 
- **user-facing friction**: 

### Verdict
- [ ] Passed without V1 fallback
- [ ] Passed with V1 fallback (acceptable)
- [ ] Failed — <root cause>

---

## Scenario 5: Visual-Only — Electron アプリのカスタム描画領域

- **date**: TBD
- **version**: TBD（v0.16.x を使用）
- **target**: VS Code / Discord / Slack 等の Electron アプリ（カスタム描画領域）
- **category**: visual-only
- **goal**: UIA/CDP が効きにくい領域で `desktop_see` の visual lane entity を確認し、`desktop_touch` でクリックを試みる

**実録手順:**
1. VS Code 等の Electron アプリを開く
2. `desktop_see` を `target: { windowTitle: "..." }` で呼ぶ
3. `sources` に `visual_gpu` が含まれる entity があるか確認
4. visual entity に `desktop_touch` を実行
5. `visual_provider_warming` / `visual_provider_unavailable` の出方を記録

**確認ポイント:**
- visual lane が取れているか（GPU pipeline が有効か）
- initial warming で 1 回目に warning が出ても 2 回目（retry 済み）で解消するか
- visual entity の lease が valid かどうか
- `executor_failed` になる場合はどの executor が fallback するか

### Steps
<!-- 実録時に記入 -->

### Observations
<!-- 実録時に記入 -->
- **round-trips**: 
- **warnings seen**: 
- **fail reasons seen**: 
- **fallback taken**: 
- **user-facing friction**: 

### Verdict
- [ ] Passed without V1 fallback
- [ ] Passed with V1 fallback (acceptable)
- [ ] Failed — <root cause>

---

## 進捗サマリ

| # | シナリオ | 日付 | Verdict | V1 fallback |
|---|---|---|---|---|
| S1 | browser-form | TBD | - | - |
| S2 | browser-click | TBD | - | - |
| S3 | terminal | TBD | - | - |
| S4 | native-dialog | TBD | - | - |
| S5 | visual-only | TBD | - | - |
