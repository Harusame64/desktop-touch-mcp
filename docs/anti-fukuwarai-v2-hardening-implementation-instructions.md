# Anti-Fukuwarai v2 — Hardening 実装指示書

作成: 2026-04-23  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
対象: dogfood 後の post-Go hardening  
目的: hardening backlog を **順次修正** で実装し、`v0.17.0` の default-on release candidate 品質を引き上げる

---

## 1. この指示書の位置づけ

`v0.17.0` の default-on 判定自体は **Go** まで到達している。  
したがって、このバッチ群の目的は release blocker を新たに増やすことではなく、dogfood で露出した friction を順次減らすことにある。

今回の前提:

- Tier 1 / Tier 2 は完了済み
- `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` の kill switch は実装済み
- V1 tools は escape hatch として残す
- release / version bump / tag / publish はこの指示書の範囲外

この指示書は、次の hardening backlog を **一気に文書化し、実装は順番に進める** ためのものである。

- H1. Lease / TTL hardening
- H4. Visual escalation / GPU trigger
- H2. Negative capability surfacing
- H3. Window hierarchy / common dialog
- H5-H7. 個別 polish（window targeting / encoding / query resilience）

優先順は backlog に従い、**H1 -> H4 -> H2 -> H3 -> H5-H7** とする。

---

## 2. 最初に読むこと

着手前に、次を読むこと。

1. [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-backlog.md)
2. [dogfood-incident-report.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/dogfood-incident-report.md)
3. [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md)
4. [anti-fukuwarai-v2-v17-final-decision-memo.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-v17-final-decision-memo.md)
5. [Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/Anti-Fukuwarai-V2.md)

実装対象として最低限読む候補:

- [src/engine/world-graph/session-registry.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/session-registry.ts)
- [src/engine/world-graph/lease-store.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/lease-store.ts)
- [src/engine/world-graph/guarded-touch.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/guarded-touch.ts)
- [src/engine/world-graph/resolver.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/resolver.ts)
- [src/engine/world-graph/types.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/types.ts)
- [src/tools/desktop.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop.ts)
- [src/tools/desktop-register.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-register.ts)
- [src/tools/desktop-executor.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-executor.ts)
- [src/tools/_resolve-window.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/_resolve-window.ts)
- [src/tools/window.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/window.ts)
- [src/tools/desktop-providers/compose-providers.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/compose-providers.ts)
- [src/tools/desktop-providers/uia-provider.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/uia-provider.ts)
- [src/tools/desktop-providers/visual-provider.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/visual-provider.ts)
- [src/tools/desktop-providers/terminal-provider.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/terminal-provider.ts)

テスト候補:

- [tests/unit/desktop-activation.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-activation.test.ts)
- [tests/unit/desktop-executor.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-executor.test.ts)
- [tests/unit/desktop-facade.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-facade.test.ts)
- [tests/unit/desktop-providers.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-providers.test.ts)
- [tests/unit/desktop-providers-active-target.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-providers-active-target.test.ts)
- [tests/unit/desktop-register.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-register.test.ts)
- [tests/unit/guarded-touch.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/guarded-touch.test.ts)

---

## 3. 大原則

### 3.1. 一括改修ではなく順次修正

この backlog はまとめて書いてあるが、**実装は小さいバッチごとに閉じる**こと。  
各バッチで build / test を通し、次に進む。

### 3.2. safety contract を壊さない

特に次は維持すること。

- stale lease 拒否
- `validate -> execute` の safety
- `desktop_see` / `desktop_touch` の warning / fail reason contract
- V1 fallback の escape hatch

### 3.3. hardening は「できないことを減らす」だけでなく「分かるようにする」

今回の dogfood では、失敗そのものより「なぜ失敗したかが structured に見えない」ことが friction になっている。  
挙動を直すのと同じくらい、**理由を返す** ことを重視すること。

---

## 4. 実装順

## Batch H1 — Lease / TTL hardening

### 4.1. 目的

`lease_expired` の過剰発生を減らす。  
特に `view=explore` や large payload のとき、LLM 処理時間に負けて lease が切れやすい問題を抑える。

### 4.2. スコープ

まずは **response-size aware TTL** を第一候補とする。

やること:

1. lease 発行時の TTL 算定箇所を特定する
2. entity 数 / payload size / `view=explore` を基に TTL を加算できるようにする
3. `action` view の軽いケースには過剰な TTL を付けない
4. stale lease safety は維持する

### 4.3. 主に触る候補

- `session-registry.ts`
- `lease-store.ts`
- `types.ts`
- `desktop.ts`
- `guarded-touch.ts`

### 4.4. やらないこと

- see/touch API をまとめて 1 ツール化する
- touch-side で無条件 grace を入れて stale lease を通す
- TTL を一律で大幅に伸ばすだけで終える

### 4.5. 完了条件

- S1 / S3 相当の再現で `lease_expired` が明確に減る
- stale lease が通って誤操作する回帰がない

### 4.6. 推奨テスト

```bash
npx vitest run tests/unit/guarded-touch.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-providers.test.ts
```

必要なら TTL 算定専用 test を新設してよい。

---

## Batch H4 — Visual escalation / GPU trigger

### 5.1. 目的

PWA / Electron の `single-giant-pane` ケースで、OCR fallback 前に visual lane を試せるようにする。  
また、visual lane が上がらなかった理由を operator / LLM から分かるようにする。

### 5.2. スコープ

やること:

1. `sparse UIA + no CDP` を visual escalation 候補に入れる
2. `single-giant-pane` ヒントを昇格判断に使えるか検討する
3. `view=debug` 時に visual lane を試行しやすくする
4. visual 未発動時の理由を response か debug 情報に出す

### 5.3. 主に触る候補

- `desktop-providers/compose-providers.ts`
- `desktop-providers/visual-provider.ts`
- `desktop-providers/uia-provider.ts`
- `desktop.ts`
- `desktop-register.ts`

### 5.4. やらないこと

- GPU lane を常時 mandatory にする
- full-frame OCR を常用 path に戻す
- visual lane の大規模再設計をこのバッチだけでやりきろうとする

### 5.5. 完了条件

- S5 / Outlook PWA 系で visual lane が以前より早く試される
- 上がらない場合でも「なぜ上がらなかったか」が分かる

### 5.6. 推奨テスト

```bash
npx vitest run tests/unit/desktop-providers.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-register.test.ts
```

必要なら `single-giant-pane` 相当の fixture / mock を足す。

---

## Batch H2 — Negative capability surfacing

### 6.1. 目的

LLM が「0 entities = 空」「textbox = type できる」と誤推論しないよう、  
provider / executor の制約を structured に返せるようにする。

### 6.2. スコープ

第一段階では **view-level constraints + 軽い entity-level capability** を目指す。

やること:

1. `desktop_see` response に provider blind / unavailable 情報を返す
2. terminal lane などで `read はできるが type は不可` を表せるようにする
3. `executor_failed` の背景にある「そもそも非対応」を見せる
4. tool description と docs の wording も必要なら最小更新する

### 6.3. 主に触る候補

- `types.ts`
- `resolver.ts`
- `candidate-ingress.ts`
- `terminal-ingress.ts`
- `visual-ingress.ts`
- `desktop.ts`
- `desktop-register.ts`

### 6.4. やらないこと

- すべての capability を一度に exhaustively モデル化する
- response schema を大きく壊す
- warning / fail reason と capability を混同する

### 6.5. 完了条件

- `desktop_see` の出力だけで fallback 判断がしやすくなる
- `executor_failed` / entity zero の意味が前より分かる

### 6.6. 推奨テスト

```bash
npx vitest run tests/unit/desktop-facade.test.ts tests/unit/desktop-providers.test.ts tests/unit/desktop-register.test.ts
```

---

## Batch H3 — Window hierarchy / common dialog

### 7.1. 目的

Save As / Open などの common dialog で、flat `hwnd` / `windowTitle` モデルに起因する到達不能を減らす。  
まずは **common dialog hardening** に絞る。

### 7.2. スコープ

第一段階では次のどちらかを最低ラインにする。

1. V2 `desktop_see` が dialog により安定して到達できる
2. V1 resolver が dialog を安定して掴める

やること:

1. owner / modal child / active window を使った hierarchy-aware resolution を検討する
2. common dialog 特例 resolver を導入できるか確認する
3. `@active` / `hwnd` / `windowTitle` 解決の不一致を減らす
4. 必要なら `focus_window` / `click_element` / `set_element_value` 周辺の resolver を改善する

### 7.3. 主に触る候補

- `_resolve-window.ts`
- `window.ts`
- `desktop.ts`
- `desktop-executor.ts`
- `desktop-register.ts`

必要に応じて native tool 側の resolver 実装も見ること。

### 7.4. やらないこと

- window model 全面刷新
- target spec に大きな breaking change を入れる
- dialog 以外まで広げた大規模な resolver rewrite

### 7.5. 完了条件

- S4 相当で direct target か V1 resolver のどちらかが改善する
- unguarded keyboard fallback 前提を少しでも減らせる

### 7.6. 推奨テスト

```bash
npx vitest run tests/unit/desktop-facade.test.ts tests/unit/desktop-register.test.ts tests/unit/guarded-touch.test.ts
```

必要なら common dialog regression 用 test を追加する。

---

## Batch H5-H7 — 個別 polish

### 8.1. H5 terminal targeting / wait heuristics

- `windowTitle="terminal"` の曖昧一致を減らす
- PowerShell prompt pattern を `$` 前提にしない

### 8.2. H6 Japanese windowTitle encoding

- 日本語 `windowTitle` で JSON parse error が出る経路を再現テスト化
- serialization / error response を修正

### 8.3. H7 app-specific query resilience

- GitHub body `"on"` のような非標準ラベルに弱い query を補強
- 一般化しすぎず、semantic fallback を最小で入れる

**注意:**  
H5-H7 は、それぞれ単発 bugfix として切り出してよい。H1-H4 と同じバッチに混ぜ込まないこと。

---

## 9. 推奨進め方

### 9.1. バッチごとに止める

1. H1 実装
2. build / tests
3. short memo
4. H4 実装
5. build / tests
6. short memo
7. H2
8. H3

の順で進めること。

### 9.2. docs も最小更新する

各バッチで contract や operator expectation が変わる場合は、次を必要最小限で更新する。

- `anti-fukuwarai-v2-hardening-backlog.md`
- `anti-fukuwarai-v2-default-on-readiness.md`
- `anti-fukuwarai-v2-dogfood-log.md`
- `desktop_see` / `desktop_touch` description

---

## 10. 共通検証

各バッチの最後に、最低限これを回すこと。

```bash
npm run build
```

大きい節目では:

```bash
npx vitest run tests/unit/guarded-touch.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-providers.test.ts tests/unit/desktop-register.test.ts tests/unit/desktop-executor.test.ts
```

必要に応じて HTTP preflight まで行ってよいが、release 作業には入らないこと。

---

## 11. やらないこと

この指示書の範囲では次をやらない。

- `npm version`
- `git tag`
- `npm publish`
- `GitHub Release`
- default-on policy そのものの再変更
- V1 tools の削除
- API の大きな breaking redesign

---

## 12. 完了条件

この hardening 系列は、次を満たせたら一区切りでよい。

1. H1-H4 の主バッチが一通り実装済み
2. dogfood で露出した主要 friction が docs 上で backlog close できる
3. release blocker を増やさず、post-Go quality が上がっている
4. 追加で必要なものがあれば H5-H7 の個別 bugfix として切り出せる

---

## 13. 推奨 commit 粒度

1 バッチ 1 commit 以上を推奨する。

例:

```text
feat(facade): make lease ttl aware of large desktop_see payloads
feat(providers): escalate visual lane earlier for sparse-uia no-cdp targets
feat(facade): surface negative capability hints in desktop_see responses
fix(window): improve common dialog targeting for anti-fukuwarai v2 flows
fix(native): handle non-ascii windowTitle safely in set_element_value
```
