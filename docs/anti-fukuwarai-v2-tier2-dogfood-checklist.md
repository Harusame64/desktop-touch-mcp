# Anti-Fukuwarai v2 — Tier 2 Dogfood Checklist

作成: 2026-04-23  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
目的: ユーザーが 5 シナリオの実録を安全に進め、`docs/anti-fukuwarai-v2-dogfood-log.md` を埋めるための簡易チェックリスト

---

## 1. 使い方

この checklist は、`desktop_see` / `desktop_touch` の **Tier 2 実録** を進めるための手順書である。  
実録の正式な記録先は [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md) とする。

使い方:

1. まずこの checklist で事前確認を行う
2. 各シナリオを 1 本ずつ実施する
3. シナリオごとに `dogfood-log.md` を埋める
4. 5 本終わったら合格ライン 5 点を自己チェックする

---

## 2. 実録前の共通チェック

各シナリオの前に、次を確認する。

- [ ] `desktop-touch-mcp` が Claude Desktop から使える
- [ ] `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` が設定されていない
- [ ] `desktop_see` と `desktop_touch` が tool list に見える
- [ ] 可能なら browser は `--remote-debugging-port=9222` 付きで起動している
- [ ] 実録中に crash / hang / session leak が出たら、その場でメモする

### 起動確認の目安

- default-on 時の tools/list は **60 tools**
- kill switch 有効時は **58 tools**

---

## 3. シナリオ一覧

実施対象は次の 5 本。

- [ ] S1 browser-form
- [ ] S2 browser-click
- [ ] S3 terminal
- [ ] S4 native-dialog
- [ ] S5 visual-only

---

## 4. 各シナリオで必ず記録すること

`dogfood-log.md` には最低限次を記録する。

- [ ] `date`
- [ ] `version`
- [ ] `target`
- [ ] `goal`
- [ ] 実行した `desktop_see` / `desktop_touch` の steps
- [ ] `round-trips`
- [ ] `warnings seen`
- [ ] `fail reasons seen`
- [ ] `fallback taken`
- [ ] `final verdict`
- [ ] `user-facing friction`

### verdict の判断

- `Passed without V1 fallback`
- `Passed with V1 fallback (acceptable)`
- `Failed`

この 3 つのどれかを必ず付ける。

---

## 5. 実録時の判断ルール

### 5.1. V2 単独 success

次を満たす場合は `Passed without V1 fallback` としてよい。

- `desktop_see` / `desktop_touch` だけで目的達成
- warning が出ても結果として成功
- fail reason が出ずに完了

### 5.2. 許容 fallback

次は `Passed with V1 fallback (acceptable)` としてよい。

- V2 で 1 回つまずいた
- V1 fallback を **1 回以内** 使って完了
- fallback 後に目的が達成できた

### 5.3. failure

次は `Failed` とする。

- V2 でも V1 でも目的達成できない
- crash / hang / session leak が出た
- warning / fail reason が docs と矛盾して解釈できない

---

## 6. warning / fail reason の見方

実録中に次が出ても、即 failure とは限らない。

### `desktop_see` warnings

- `visual_provider_warming`
- `visual_provider_unavailable`
- `partial_results_only`
- `no_provider_matched`
- `cdp_provider_failed`
- `uia_provider_failed`
- `terminal_provider_failed`

見るポイント:

- retry 後に解消したか
- structured lane だけで継続できたか
- V1 fallback に素直に移れたか

### `desktop_touch` fail reasons

- `lease_expired`
- `lease_generation_mismatch`
- `lease_digest_mismatch`
- `entity_not_found`
- `modal_blocking`
- `entity_outside_viewport`
- `executor_failed`

見るポイント:

- fail reason の意味が理解しやすかったか
- docs の fallback 導線どおりに回復できたか

注意:

- `focus_shifted` は **fail reason ではなく観測シグナル**

---

## 7. シナリオ別メモ

### S1 browser-form

- [ ] title / body の両方を試した
- [ ] `cdp` source を確認した
- [ ] warning があれば記録した

### S2 browser-click

- [ ] Compose / 新規作成ボタンの click を試した
- [ ] `browser_click_element` と比べた違和感をメモした

### S3 terminal

- [ ] `git status` を送信した
- [ ] フォアグラウンドが奪われていないか見た
- [ ] `executor_failed` が出たかを記録した

### S4 native-dialog

- [ ] 名前入力と保存ボタン押下を試した
- [ ] `modal_blocking` / `entity_outside_viewport` が出たかを見た

### S5 visual-only

- [ ] Electron の custom-drawn 領域で試した
- [ ] `visual_provider_warming` / `visual_provider_unavailable` の頻度を見た
- [ ] V1 fallback の必要性を記録した

---

## 8. 合格ラインの自己チェック

全シナリオ後に次をチェックする。

- [ ] 5 シナリオ全て記録済み
- [ ] 3 シナリオ以上が V2 単独 pass、または V1 fallback 1 回以内で成功
- [ ] fail したシナリオでも V1 fallback 成功
- [ ] warning / fail reason が docs と整合
- [ ] crash / hang / session leak 0 件

5 つ全て満たせば、**Tier 2 合格** として最終判定に進める。

---

## 9. 実録後にやること

1. [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md) を保存する
2. 合格ライン 5 点の結果をまとめる
3. その内容をもとに、final decision / release 判定へ進む

