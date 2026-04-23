# Anti-Fukuwarai v2 — v0.17.0 Default-On Final Decision Memo

作成: 2026-04-23  
判定者: Claude Sonnet 4.6 (1M context) + Opus レビュー（ad5b15147b0de497b）  
参照: [tier2-final-decision-instructions.md](anti-fukuwarai-v2-tier2-final-decision-instructions.md)  
注意: 本メモは旧 [anti-fukuwarai-v2-ship-decision-memo.md](anti-fukuwarai-v2-ship-decision-memo.md)（v0.16.0 opt-in ship の判断）を置き換えるものではなく、v0.17.0 default-on 専用の判定 memo である。

---

## Decision

**Go — v0.17.0 default-on release candidate として進行可**

---

## Why

Tier 1（技術的暫定 Go）に加え、Tier 2 dogfood 5 シナリオが完了し、合格ライン 5 点を全て満たした。

- S1 browser-form: **Passed without V1 fallback**
- S2 browser-click: **Passed with V1 fallback (acceptable)**
- S3 terminal: **Passed with V1 fallback (acceptable)**
- S4 native-dialog: **Failed**, but V1 fallback で最終成功
- S5 visual-only: **Passed with V1 fallback (acceptable)**

このため、`tier2-final-decision-instructions.md §6` の Go 条件を満たし、v0.17.0 default-on release candidate として release process に進める。

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

✅ **完了** — S1〜S5 実録済み

| # | シナリオ | カテゴリ | 状態 |
|---|---|---|---|
| S1 | Issue タイトル入力 | browser-form | ✅ V2 単独 pass |
| S2 | Webmail Compose ボタン | browser-click | ✅ V1 fallback 1 回以内で成功 |
| S3 | git status 送信 | terminal | ✅ V1 fallback 1 回以内で成功 |
| S4 | 名前を付けて保存 | native-dialog | ⚠️ V2 fail / V1 fallback 成功 |
| S5 | Electron カスタム描画領域 | visual-only | ✅ V1 fallback 1 回以内で成功 |

---

## Gate Summary

| Gate | 状態 | 備考 |
|---|---|---|
| G1: modal/viewport/focus wiring | ✅ 閉 | P4-C 完了 |
| G2: terminal WM_CHAR background path | ✅ 閉 | P4-C 完了 |
| G3: dogfood 実録 5 シナリオ | ✅ 閉 | Tier 2 実録完了 |
| G4: visual attach retry | ✅ 閉 | Batch B 完了 |
| G5: cdpPort 対応 | 🔵 Deferred | default-on 後に要望ベース |

---

## 合格ライン 5 点 判定

| # | 条件 | 判定 |
|---|---|---|
| 1 | 5 シナリオ全て記録済み | ✅ |
| 2 | 3 シナリオ以上が V2 単独 pass / V1 fallback 1 回以内 | ✅ |
| 3 | fail したシナリオで V1 fallback 成功 | ✅ |
| 4 | warning / fail reason が docs と整合 | ✅ |
| 5 | crash / hang / session leak 0 件 | ✅ |

---

## Release Outcome

- **推奨**: v0.17.0 を default-on release candidate として進める
- **kill switch**: `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1`
- **互換**: V1 tools は catalog に残し、fallback / escape hatch として維持
- **deprecation**: `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` は v0.17.x では deprecated 互換として受理し、v0.18.0+ で撤去予定

---

## Next Action（Go）

1. `docs/release-process.md` を full read
2. `npm version 0.17.0 --no-git-tag-version`
3. `npm run build` / `npm publish --dry-run` / HTTP preflight
4. `git commit` / `git tag v0.17.0` / `git push origin v0.17.0`
5. CI（GitHub Actions release.yml）で zip 生成完了を待つ
6. `gh release view v0.17.0 --json assets` で zip 存在確認後に `npm publish`
7. クリーンキャッシュで npx スモークテスト

---

## Post-Go Hardening Items

1. **Lease TTL**
   - large `explore` 応答を読むと `desktop_see -> desktop_touch` 間で `lease_expired` が出やすい。
   - 候補: TTL 延長、response-size aware TTL、see/touch 往復短縮。

2. **Visual lane trigger**
   - Electron / PWA の `single-giant-pane` ケースで visual lane が起動せず、OCR fallback に依存した。
   - 候補: sparse UIA + no CDP 時の visual lane 昇格条件見直し、debug/force visual の明文化。

3. **Native common file dialog**
   - Windows common dialog では V2 path が成立しなかった。
   - 候補: common dialog resolver / UIA bridge reachability の再調査、V1 fallback docs 強化。
