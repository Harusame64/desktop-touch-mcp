# Anti-Fukuwarai v2 — Tier 2 Final Decision Instructions

作成: 2026-04-23  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
目的: Tier 2 dogfood 実録完了後に、`v0.17.0 default-on` の Go / No-Go を最終判定するための instructions

---

## 1. このバッチの目的

Batch C 時点で、Tier 1 は **技術的暫定 Go** まで完了している。  
残っているのは Tier 2 のユーザー実録結果を読み込み、`v0.17.0 default-on` を最終的に出してよいか決めることである。

ここでやること:

1. `dogfood-log.md` の 5 シナリオ結果を読む
2. 合格ライン 5 点を判定する
3. `Go / No-Go` を 1 枚に固定する
4. Go の場合だけ release 実行へ進むための next action をまとめる

重要:

- ここでは **release 実行自体はしない**
- `npm version` / `tag` / `publish` はまだ実行しない
- 判定の根拠は必ず `dogfood-log.md` に置く

---

## 2. 最初に読むこと

着手前に次を読むこと。

1. [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md)
2. [anti-fukuwarai-v2-tier2-dogfood-checklist.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-tier2-dogfood-checklist.md)
3. [anti-fukuwarai-v2-batch-c-tier1-review.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-batch-c-tier1-review.md)
4. [anti-fukuwarai-v2-default-on-readiness.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-default-on-readiness.md)
5. [anti-fukuwarai-v2-activation-policy.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-activation-policy.md)
6. [anti-fukuwarai-v2-coexistence-policy.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-coexistence-policy.md)
7. [release-process.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/release-process.md)

---

## 3. 判定ルール

### Go 条件

次の 5 点を全て満たしたら Go とする。

1. 5 シナリオ全て記録済み
2. 3 シナリオ以上が V2 単独 pass、または V1 fallback 1 回以内で成功
3. fail したシナリオでも V1 fallback 成功
4. warning / fail reason が docs と整合
5. crash / hang / session leak 0 件

### No-Go 条件

次のどれかがあれば No-Go。

- 5 シナリオのうち未実施がある
- fallback しても回復しないシナリオがある
- warning / fail reason が docs と矛盾している
- crash / hang / session leak が 1 件でもある
- visual-only シナリオが全く安定しない

---

## 4. 期待する成果物

最低限ほしい成果物は次の 1 枚。

- `docs/anti-fukuwarai-v2-v17-final-decision-memo.md`

構成は次を推奨する。

```text
Decision
Why
Tier 1 status
Tier 2 status
Gate summary
Go / No-Go rationale
Next action
```

### Go の場合

- `v0.17.0 default-on release candidate`
- release 実行へ進んでよい
- `release-process.md` へ接続

### No-Go の場合

- `v0.16.x patch で dogfood 継続`
- 不足シナリオ / 問題点を列挙
- 次に埋めるべき gap を明記

---

## 5. Next Action の書き方

### Go の場合

次の順で書く。

1. `release-process.md` を full read
2. `npm version v0.17.0 --no-git-tag-version`
3. build / preflight
4. commit / tag / push
5. CI / smoke / registry

### No-Go の場合

次の順で書く。

1. どのシナリオが不足か
2. fallback で何が詰まったか
3. docs / code のどこを直すか
4. 次の dogfood 再実施条件

---

## 6. 注意

- 旧 [anti-fukuwarai-v2-ship-decision-memo.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-ship-decision-memo.md) は `v0.16.0 opt-in ship` 時点の memo であり、今回の default-on 判定ではそのまま使わない
- Tier 2 実録が埋まっていない場合、Go を出さない
- `focus_shifted` は fail reason ではなく signal

