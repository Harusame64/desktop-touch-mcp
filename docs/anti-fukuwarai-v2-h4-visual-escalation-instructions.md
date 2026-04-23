# Anti-Fukuwarai v2 — Batch H4 Visual Escalation 実装指示書

作成: 2026-04-23  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
対象: post-Go hardening の第 2 バッチ候補  
目的: `single-giant-pane + no CDP` な target で visual lane をより早く試せるようにし、未発動時の理由も見えるようにする

---

## 1. このバッチの目的

dogfood では次のようなケースで、`desktop_see` が entity を返せず、最終的に OCR fallback に依存した。

1. **S2 browser-click (Outlook PWA)**
   - `single-giant-pane`
   - PWA が CDP 未接続
   - visual lane も上がらず、OCR + `mouse_click`
2. **S5 visual-only (Electron / Codex)**
   - `single-giant-pane`
   - `--remote-debugging-port` なし
   - `view=debug` でも visual lane 不発

このバッチの目的は、GPU lane を常時 mandatory にすることではない。  
**structured lane が blind / sparse で、CDP もないときに、visual lane をより自然に昇格させること**、そして**昇格しなかった理由を response から分かるようにすること**が目的である。

---

## 2. 最初に読むこと

着手前に、次を読むこと。

1. [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-backlog.md)
2. [dogfood-incident-report.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/dogfood-incident-report.md)
3. [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md)
4. [anti-fukuwarai-v2-hardening-implementation-instructions.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-implementation-instructions.md)
5. [Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/Anti-Fukuwarai-V2.md)

次に、実装対象として最低限これを読むこと。

- [src/tools/desktop-providers/compose-providers.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/compose-providers.ts)
- [src/tools/desktop-providers/uia-provider.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/uia-provider.ts)
- [src/tools/desktop-providers/visual-provider.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/visual-provider.ts)
- [src/tools/desktop-providers/browser-provider.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/browser-provider.ts)
- [src/tools/desktop-register.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-register.ts)
- [src/tools/desktop.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop.ts)
- [src/engine/world-graph/types.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/types.ts)

テスト候補:

- [tests/unit/desktop-providers.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-providers.test.ts)
- [tests/unit/desktop-facade.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-facade.test.ts)
- [tests/unit/desktop-register.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-register.test.ts)
- [tests/unit/desktop-providers-active-target.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-providers-active-target.test.ts)

---

## 3. 現在地

Batch B で `visual_provider_unavailable` / `visual_provider_warming` に対する retry は導入済みである。  
つまり、今回の焦点は **retry 後の provider そのもの** ではなく、その前段の **「いつ visual lane を候補にするか」** と **「なぜ候補にならなかったか」** にある。

このバッチは release blocker 解消ではなく post-Go hardening であるが、PWA / Electron 体感に直接効くため優先度は高い。

---

## 4. 実装方針

### 4.1. visual lane の昇格条件を少し広げる

第一候補は、次の signal を visual escalation に使うことである。

- `sparse UIA`
- `single-giant-pane`
- `CDP unavailable`
- `query` ありでも entity 0 件

ただし、structured lane が十分に取れているケースまで visual を常用化してはいけない。

### 4.2. 未発動理由を response に出す

dogfood では `desktop_see` が 0 entities でも、「UIA blind なのか」「CDP 未接続なのか」「visual lane が候補に入らなかったのか」が見えにくかった。  
そのため、少なくとも debug 情報か response 補助情報として、未発動理由が読める状態を目指すこと。

### 4.3. OCR 常用 path に戻さない

今回のゴールは OCR fallback の前に visual lane を試しやすくすることだが、full-frame OCR を常用 path に戻すことではない。  
OCR はあくまで fallback のまま維持すること。

---

## 5. 期待する到達点

このバッチで最低限ほしい状態:

1. `single-giant-pane + no CDP` の target で visual lane が以前より候補になりやすい
2. visual lane が起動しなかった場合も、理由が response から読める
3. `desktop_see` が 0 entities を返すだけの opaque failure を減らす
4. existing warning / fail reason contract は壊さない

---

## 6. 実装候補

### 6.1. 推奨アプローチ

第一段階では、次の 2 つを分けて実装すること。

1. **escalation 条件の見直し**
   - `compose-providers` 側で visual lane を入れる条件を拡張
2. **explainability の追加**
   - `debug` 情報、または `desktop_see` response の補助情報に
     - `cdp_unavailable`
     - `uia_blind`
     - `visual_not_attempted`
     - `visual_attempted_but_unavailable`
     のような理由を載せる

### 6.2. 段階的な候補

段階 1:

- `single-giant-pane` を visual candidate 判定に使う
- `no cdp + sparse uia` で visual lane を試しやすくする
- `view=debug` では visual をより積極的に試す

段階 2:

- visual 未発動理由の structured 出力
- `desktop_see` 0 entities 時の補助ヒント強化

### 6.3. 主に触る可能性が高い箇所

- `desktop-providers/compose-providers.ts`
- `desktop-providers/uia-provider.ts`
- `desktop-providers/visual-provider.ts`
- `desktop.ts`
- `desktop-register.ts`
- 必要なら `types.ts`

---

## 7. やらないこと

このバッチでは次をやらないこと。

- visual lane を常時 mandatory にする
- GPU path の全面 redesign
- OCR fallback を primary path に戻す
- negative capability の全面モデリング
- common dialog / window hierarchy の修正
- release / version bump / tag / publish

---

## 8. テスト観点

### 8.1. 最低限確認したいこと

1. `single-giant-pane + no CDP` のケースで visual lane 候補判定が以前より積極的になる
2. structured lane が十分なケースでは visual 常用にならない
3. `view=debug` のとき、visual 試行の有無や理由が分かる
4. existing retry (`visual_provider_unavailable` / `warming`) と矛盾しない

### 8.2. 回す候補

```bash
npm run build
npx vitest run tests/unit/desktop-providers.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-register.test.ts tests/unit/desktop-providers-active-target.test.ts
```

必要なら `single-giant-pane` 相当の fixture / mock を足してよい。

---

## 9. docs 更新

実装後、必要なら最小限で次を更新してよい。

- [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-backlog.md)
- [anti-fukuwarai-v2-default-on-readiness.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-default-on-readiness.md)
- [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md)
- `desktop_see` description

---

## 10. 完了条件

このバッチは、次を満たしたら完了でよい。

1. visual escalation 条件が dogfood 実録に沿って改善されている
2. 0 entities / visual 未発動の理由が以前より分かる
3. OCR fallback 依存が少しでも減る方向になっている
4. build と関連 unit tests が通る

---

## 11. 推奨 commit

```text
feat(providers): escalate visual lane earlier for sparse-uia no-cdp targets
```
