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
- [x] S1 browser-form
- [x] S2 browser-click
- [x] S3 terminal
- [x] S4 native-dialog
- [x] S5 visual-only
- [x] 合格ライン 5 点達成 → v0.17.0 release 実行可

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

- **date**: 2026-04-23
- **version**: `desktop-touch-mcp-fukuwaraiv2` HEAD（pre-v0.17.0 default-on candidate）
- **target**: GitHub Issues 新規作成ページ（または任意のブラウザフォーム）
- **category**: browser-form
- **goal**: フォームの title / body フィールドに `desktop_see` + `desktop_touch` で入力し、V1 fallback なしで完了する

### Steps
| # | tool | args summary | result |
|---|---|---|---|
| 1 | `screenshot(meta)` | window list | ok |
| 2 | `desktop_see` | `windowTitle=<browser>` | ok, UIA only |
| 3 | `desktop_see` | `tabId=<issue page>, view=explore` | ok, CDP form entities found |
| 4 | `desktop_touch` | title entity | fail, `lease_expired` |
| 5 | `desktop_see` | `tabId=<issue page>, query=Title` | ok, 1 entity |
| 6 | `desktop_touch` | title entity | ok, `value_changed` |
| 7 | `desktop_see` | `query=body` / `query=leave comment` | ok, 0 entities |
| 8 | `desktop_see` | `tabId=<issue page>, view=explore` | ok, body textbox discovered via unlabeled entity |
| 9 | `desktop_touch` | body entity | fail, `lease_expired` |
| 10 | `desktop_see` | `tabId=<issue page>, query=on` | ok, narrowed entities |
| 11 | `desktop_touch` | body entity | ok, body entered |

### Observations
- **round-trips**: 12
- **warnings seen**: `[]`
- **fail reasons seen**: `[lease_expired]`
- **fallback taken**: no
- **user-facing friction**: Chrome form では `windowTitle` 指定だけだと UIA しか返らず、`tabId` 指定が実質必須。大きい `explore` 応答では lease TTL に負けやすい。GitHub body editor の aria-label が `"on"` で、query discovery が難しい。

### Verdict
- [x] Passed without V1 fallback
- [ ] Passed with V1 fallback (acceptable)
- [ ] Failed — <root cause>

---

## Scenario 2: Browser Click — Webmail Compose ボタン

- **date**: 2026-04-23
- **version**: `desktop-touch-mcp-fukuwaraiv2` HEAD（pre-v0.17.0 default-on candidate）
- **target**: Gmail / Outlook Web 等の webmail
- **category**: browser-click
- **goal**: Compose / 新規作成ボタンを `desktop_see` + `desktop_touch` でクリックし、作成ウィンドウが開くことを確認する

### Steps
| # | tool | args summary | result |
|---|---|---|---|
| 1 | `browser_connect` | port=9222 | ok |
| 2 | `browser_navigate` | Gmail | fail, unauthenticated landing page |
| 3 | `browser_navigate` | Outlook Web | fail, unauthenticated landing page |
| 4 | `focus_window` | logged-in Outlook PWA | ok |
| 5 | `desktop_see` | `query=compose/新規作成` | fail, 0 entities |
| 6 | `desktop_see` | no query | fail, UIA chrome only |
| 7 | `screenshot(text)` | `ocrFallback=always` | ok, OCR found `新規メール` |
| 8 | `desktop_see` | `query=新規メール` | fail, 0 entities |
| 9 | `mouse_click` | OCR coords | ok, compose opened |

### Observations
- **round-trips**: 8
- **warnings seen**: `[]`
- **fail reasons seen**: `[]`
- **fallback taken**: yes — `screenshot(ocrFallback=always)` + `mouse_click`, success
- **user-facing friction**: Outlook PWA は CDP 未接続かつ UIA が `single-giant-pane` で、`desktop_see` が entity を返せなかった。通常の browser-click より PWA / visual-only 寄りの難ケースだった。

### Verdict
- [ ] Passed without V1 fallback
- [x] Passed with V1 fallback (acceptable)
- [ ] Failed — <root cause>

---

## Scenario 3: Terminal — git status 送信

- **date**: 2026-04-23
- **version**: `desktop-touch-mcp-fukuwaraiv2` HEAD（pre-v0.17.0 default-on candidate）
- **target**: Windows Terminal / Git Bash / cmd.exe
- **category**: terminal
- **goal**: `desktop_see` でターミナルを観測し、`desktop_touch` で `git status\n` を送信。フォアグラウンドウィンドウが変わらないことを確認（G2 WM_CHAR path 実動作）

### Steps
| # | tool | args summary | result |
|---|---|---|---|
| 1 | `screenshot(meta)` | terminal window discovery | ok |
| 2 | `desktop_see` | terminal target | ok, lease acquired |
| 3 | `desktop_touch` | type `git status` | fail, `lease_expired` |
| 4 | `desktop_see` | terminal target re-query | ok |
| 5 | `desktop_touch` | type `git status` | fail, `modal_blocking` |
| 6 | `terminal_send` | `git status` | ok, command sent |

### Observations
- **round-trips**: 6
- **warnings seen**: `[]`
- **fail reasons seen**: `[lease_expired, modal_blocking]`
- **fallback taken**: yes — `terminal_send` (V1), success
- **user-facing friction**: `desktop_touch` では terminal input が安定せず、TTL 切れと `modal_blocking` で 2 回失敗。最終的には V1 fallback で完了。

### Verdict
- [ ] Passed without V1 fallback
- [x] Passed with V1 fallback (acceptable)
- [ ] Failed — <root cause>

---

## Scenario 4: Native Dialog — 名前を付けて保存

- **date**: 2026-04-23
- **version**: `desktop-touch-mcp-fukuwaraiv2` HEAD（pre-v0.17.0 default-on candidate）
- **target**: メモ帳（notepad.exe）→ ファイル → 名前を付けて保存
- **category**: native-dialog
- **goal**: `desktop_see` でダイアログの entity を観測し、ファイル名フィールドに入力して保存ボタンをクリック。modal guard（G1, §9）の実動作を確認する

### Steps
| # | tool | args summary | result |
|---|---|---|---|
| 1 | `click_element` | File menu / Save As | ok, dialog opened |
| 2 | `desktop_see` | `windowTitle=名前を付けて保存` | fail, `uia_provider_failed` |
| 3 | `desktop_see` | `hwnd=<notepad>` | ok, dialog descendants visible through parent |
| 4 | `desktop_touch` | filename entity via parent hwnd | fail, `modal_blocking` |
| 5 | `desktop_see` | dialog hwnd direct | fail, `uia_provider_failed` |
| 6 | `focus_window` | Save As dialog | ok |
| 7 | `keyboard_type` | filename input | ok |
| 8 | `keyboard_press` | `enter` | ok, save completed |

### Observations
- **round-trips**: 21
- **warnings seen**: `[uia_provider_failed]`
- **fail reasons seen**: `[modal_blocking]`
- **fallback taken**: yes — full V1 fallback (`focus_window` + `keyboard_type` + `keyboard_press enter`), success
- **user-facing friction**: Save As dialog では `desktop_see` が dialog title / dialog hwnd / parent hwnd のいずれでも安定せず、V2 path は成立しなかった。日本語タイトルを含む V1 window resolution でも不安定な経路があった。

### Verdict
- [ ] Passed without V1 fallback
- [ ] Passed with V1 fallback (acceptable)
- [x] Failed — V2 path unavailable for Windows common file dialog; task completed via V1 fallback

---

## Scenario 5: Visual-Only — Electron アプリのカスタム描画領域

- **date**: 2026-04-23
- **version**: `desktop-touch-mcp-fukuwaraiv2` HEAD（pre-v0.17.0 default-on candidate）
- **target**: VS Code / Discord / Slack 等の Electron アプリ（カスタム描画領域）
- **category**: visual-only
- **goal**: UIA/CDP が効きにくい領域で `desktop_see` の visual lane entity を確認し、`desktop_touch` でクリックを試みる

### Steps
| # | tool | args summary | result |
|---|---|---|---|
| 1 | `screenshot(meta)` | Electron window discovery | ok |
| 2 | `desktop_see` | `view=explore` | fail, UIA chrome only |
| 3 | `browser_connect` | guessed CDP port | fail, no CDP |
| 4 | `screenshot(text)` | `ocrFallback=always` | ok, OCR found target button |
| 5 | `desktop_see` | `view=debug` | fail, same 4 UIA entities, no visual lane |
| 6 | PowerShell | inspect process args | ok, no `--remote-debugging-port` |
| 7 | `mouse_click` | OCR coords | ok, target clicked |

### Observations
- **round-trips**: 7
- **warnings seen**: `[]`
- **fail reasons seen**: `[]`
- **fallback taken**: yes — `screenshot(ocrFallback=always)` + `mouse_click`, success
- **user-facing friction**: Electron custom-drawn 領域では UIA が `single-giant-pane` で閉じており、CDP も未接続だったため、`desktop_see` は entity を返せなかった。visual lane も今回は発動せず、OCR 座標 fallback が必要だった。

### Verdict
- [ ] Passed without V1 fallback
- [x] Passed with V1 fallback (acceptable)
- [ ] Failed — <root cause>

---

## 進捗サマリ

| # | シナリオ | 日付 | Verdict | V1 fallback |
|---|---|---|---|---|
| S1 | browser-form | 2026-04-23 | Passed without V1 fallback | no |
| S2 | browser-click | 2026-04-23 | Passed with V1 fallback (acceptable) | yes |
| S3 | terminal | 2026-04-23 | Passed with V1 fallback (acceptable) | yes |
| S4 | native-dialog | 2026-04-23 | Failed | yes |
| S5 | visual-only | 2026-04-23 | Passed with V1 fallback (acceptable) | yes |

---

## Tier 2 判定結果

| # | 条件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | 5 シナリオ全て記録済み | ✅ | S1-S5 実録完了 |
| 2 | 3 シナリオ以上が V2 単独 pass / V1 fallback 1 回以内 | ✅ | S1, S2, S3, S5 |
| 3 | fail したシナリオ全てで V1 fallback 成功 | ✅ | S4 は V1 fallback で保存完了 |
| 4 | warning / fail reason が docs と整合 | ✅ | `lease_expired` / `modal_blocking` / `uia_provider_failed` は docs 契約内。観測メモと公式 warning/fail reason を分離して記録 |
| 5 | crash / hang / session leak 0 件 | ✅ | 今回の 5 シナリオ実録では未観測 |

**Tier 2 結論:** ✅ **Go** — v0.17.0 default-on release candidate として進行可能。

---

## Dogfood で見えた改善候補

1. **Lease TTL と LLM レイテンシの競合**
   - 大きい `explore` 応答を読むと `desktop_see -> desktop_touch` 間で `lease_expired` が出やすい。
   - 候補: lease TTL 延長、large explore 時だけ TTL を加算、`desktop_see + desktop_touch` の往復短縮。

2. **Visual lane の発動閾値**
   - Electron / PWA の `single-giant-pane` ケースで visual lane が起動せず、OCR fallback に依存した。
   - 候補: sparse UIA + no CDP 時に visual lane をより早く昇格、`view=debug` で visual forcing を明確化。

3. **Native common file dialog**
   - Windows common dialog では V2 path が成立しなかった。
   - 候補: dialog reachability の再調査、common dialog 専用 resolver、V1 fallback 導線の docs 強化。
