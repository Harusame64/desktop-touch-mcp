# Anti-Fukuwarai v2 — v0.17.0 Default-On Final Decision Memo

作成: 2026-04-23  
判定者: Claude Sonnet 4.6 (1M context) + Opus レビュー（ad5b15147b0de497b）  
参照: [tier2-final-decision-instructions.md](anti-fukuwarai-v2-tier2-final-decision-instructions.md)  
注意: 本メモは旧 [anti-fukuwarai-v2-ship-decision-memo.md](anti-fukuwarai-v2-ship-decision-memo.md)（v0.16.0 opt-in ship の判断）を置き換えるものではなく、v0.17.0 default-on 専用の判定 memo である。

---

## Decision

**No-Go — v0.17.0 default-on release は保留**

---

## Why

Tier 2 dogfood 5 シナリオが未実施（S1〜S5 全て TBD）。合格ライン 1（実録数: 5 シナリオ全て記録済み）を満たしていない。

`tier2-final-decision-instructions.md §6`: 「Tier 2 実録が埋まっていない場合、Go を出さない」

Tier 1 は技術的 Go（コード準備完了）だが、release の許可は Tier 2 完了が条件。実装品質の問題ではなく、実録エビデンスが未整備なことが No-Go の唯一の理由。

---

## Tier 1 Status（技術的暫定 Go）

✅ **T1-T7 全クリア**（2026-04-23）  
🔵 **T8 N/A**（v0.16.0 未 release のため計測不可 — 合格ライン 5 「crash/hang/leak 0 件」は Tier 2 dogfood 実施時の観測で初めて埋まる）

詳細: [anti-fukuwarai-v2-batch-c-tier1-review.md](anti-fukuwarai-v2-batch-c-tier1-review.md)

| T# | チェック項目 | 結果 |
|---|---|---|
| T1 | 350 unit tests pass | ✅ |
| T2 | HTTP preflight 6/6, 60 tools（default-on） | ✅ |
| T3 | G1 modal/viewport/focus wiring — production 実接続 | ✅ |
| T4 | G2 terminal WM_CHAR background path | ✅ |
| T5 | G4 visual attach retry（両警告・1 回・全ブランチ） | ✅ |
| T6 | kill switch 実機確認（DISABLE=1 → 58 tools） | ✅ |
| T7 | warning/fail reason enum 一致（14 コード） | ✅ |
| T8 | crash/hang/leak 0 件 | 🔵 N/A（未 release） |

---

## Tier 2 Status（dogfood 実録）

❌ **未完了** — S1〜S5 全て TBD

| # | シナリオ | カテゴリ | 状態 |
|---|---|---|---|
| S1 | Issue タイトル入力 | browser-form | ❌ 未実施 |
| S2 | Webmail Compose ボタン | browser-click | ❌ 未実施 |
| S3 | git status 送信 | terminal | ❌ 未実施 |
| S4 | 名前を付けて保存 | native-dialog | ❌ 未実施 |
| S5 | Electron カスタム描画領域 | visual-only | ❌ 未実施 |

---

## Gate Summary

| Gate | 状態 | 備考 |
|---|---|---|
| G1: modal/viewport/focus wiring | ✅ 閉 | P4-C 完了 |
| G2: terminal WM_CHAR background path | ✅ 閉 | P4-C 完了 |
| G3: dogfood 実録 5 シナリオ | ❌ Open | **現在のブロッカー** |
| G4: visual attach retry | ✅ 閉 | Batch B 完了 |
| G5: cdpPort 対応 | 🔵 Deferred | default-on 後に要望ベース |

---

## 合格ライン 5 点 判定

| # | 条件 | 判定 |
|---|---|---|
| 1 | 5 シナリオ全て記録済み | ❌ **未達（S1-S5 全て未実施）** |
| 2 | 3 シナリオ以上が V2 単独 pass / V1 fallback 1 回以内 | ❌ 判定不能 |
| 3 | fail したシナリオで V1 fallback 成功 | ❌ 判定不能 |
| 4 | warning / fail reason が docs と整合 | ⚠️ enum 静的確認済み（T7 ✅）、実録確認は未実施 |
| 5 | crash / hang / session leak 0 件 | ❌ 判定不能（T8 N/A） |

---

## Holding Version Policy

- **現行**: v0.16.x で opt-in 継続（`DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1`）
- **v0.17.0 default-on**: Tier 2 実録完了・合格ライン 5 点達成後に再判定

---

## Next Action（No-Go）

### 1. ユーザーが dogfood 5 シナリオを実施する

- 手順書: `docs/anti-fukuwarai-v2-tier2-dogfood-checklist.md`
- 記録先: `docs/anti-fukuwarai-v2-dogfood-log.md`
- 各シナリオの step-by-step 手順は dogfood-log.md 内に記載済み

### 2. 実録時の注意

- `focus_shifted` は **fail reason ではなく観測シグナル**。出ても即 fail にしない
- `visual_provider_warming` / `visual_provider_unavailable` は G4 retry 後に解消するか確認
- crash / hang / session leak が出たらその場でメモ（合格ライン 5 の観測）

### 3. 合格ライン 5 点を自己チェックする

5 点全て満たした後、Claude にこの判定作業を再依頼する。

### 4. Go に更新して release へ進む（Tier 2 達成後）

1. このメモを「Go」に更新
2. `docs/release-process.md` を full read
3. `npm version 0.17.0 --no-git-tag-version` で version bump
4. `npm run build` / `npm publish --dry-run` / HTTP preflight
5. `git commit` / `git tag v0.17.0` / `git push origin v0.17.0`
6. CI（GitHub Actions release.yml）が zip 生成を完了するのを待つ
7. `gh release view v0.17.0 --json assets` で zip 存在確認
8. `npm publish`（2FA ブラウザ認証）
9. クリーンキャッシュで npx スモークテスト

### 5. 不足シナリオの優先順

実録が難しい場合は以下の順で着手を推奨:

1. **S3 terminal** — 最もシンプル（git status 送信、CDP 不要）
2. **S1 browser-form** — Chrome/Edge CDP 接続があれば比較的容易
3. **S4 native-dialog** — メモ帳があれば実施可能
4. **S2 browser-click** — S1 と同じ環境で実施可
5. **S5 visual-only** — GPU pipeline 依存、最後に実施
