# Anti-Fukuwarai v2 — Batch H3 Window Hierarchy / Common Dialog 実装指示書

作成: 2026-04-23  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
対象: post-Go hardening の次バッチ  
目的: Save As / Open などの common dialog で、flat `windowTitle` / `hwnd` モデルに起因する到達不能を減らす

---

## 1. このバッチの目的

dogfood の S4（Save As dialog）では、次の friction が集中した。

1. `desktop_see(windowTitle="名前を付けて保存")` が `uia_provider_failed`
2. 親 hwnd 経由では read できても `desktop_touch` が `modal_blocking`
3. V1 でも `WindowNotFound` / `ElementNotFound`
4. 最終的に unguarded keyboard fallback へ落ち、誤フォーカス事故リスクが高い

このバッチの目的は window model 全面刷新ではない。  
**common dialog を中心に、owner / modal / active child を少し理解できる resolver を入れて、Save As 系の到達率を上げること**が目的である。

---

## 2. 最初に読むこと

着手前に、次を読むこと。

1. [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-backlog.md)
2. [dogfood-incident-report.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/dogfood-incident-report.md)
3. [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md)
4. [anti-fukuwarai-v2-hardening-implementation-instructions.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-implementation-instructions.md)
5. [Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/Anti-Fukuwarai-V2.md)

次に、実装対象として最低限これを読むこと。

- [src/tools/_resolve-window.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/_resolve-window.ts)
- [src/tools/window.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/window.ts)
- [src/tools/desktop.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop.ts)
- [src/tools/desktop-register.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-register.ts)
- [src/tools/desktop-executor.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-executor.ts)
- [src/engine/world-graph/guarded-touch.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/guarded-touch.ts)
- [src/engine/world-graph/session-registry.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/session-registry.ts)

必要に応じて:

- [src/tools/context.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/context.ts)
- [src/tools/_focus.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/_focus.ts)
- [src/tools/desktop-providers/uia-provider.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/uia-provider.ts)

テスト候補:

- [tests/unit/desktop-facade.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-facade.test.ts)
- [tests/unit/desktop-register.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-register.test.ts)
- [tests/unit/guarded-touch.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/guarded-touch.test.ts)

---

## 3. 現在地

H4 で「なぜ visual / UIA が効かなかったか」の explainability は強くなった。  
次は、S4 で露出した **window hierarchy / common dialog** 問題を直す順番である。

今回は **negative capability 全面モデリング** ではなく、まず common dialog の reachability を上げるバッチとして扱う。

---

## 4. 実装方針

### 4.1. common dialog 特例を優先

全面的な window graph 再設計は大きすぎるため、まずは次を優先すること。

1. Save As / Open などの common dialog を owner chain から見つける
2. active / modal child / owner を優先して window resolve する
3. `@active` / `windowTitle` / `hwnd` 解決の不一致を減らす

### 4.2. V2 か V1 のどちらかを改善する

このバッチの最低ラインは次のどちらか。

1. `desktop_see` が dialog を安定して target できる
2. V1 resolver (`focus_window` / `click_element` / `set_element_value`) が dialog を安定して target できる

理想は両方だが、最初は片側だけでも価値がある。

### 4.3. keyboard fallback 前提を減らす

今回の Save As では最終的に unguarded keyboard へ落ちた。  
このバッチでは、少なくとも **guarded / resolved な path に戻せる可能性** を上げることを重視する。

---

## 5. 期待する到達点

このバッチで最低限ほしい状態:

1. common dialog の resolve が以前より安定する
2. `@active` / owner / modal child の関係を少し扱える
3. Save As で `WindowNotFound` / `ElementNotFound` / `modal_blocking` の連鎖が減る
4. unguarded keyboard fallback 依存が少しでも下がる

---

## 6. 実装候補

### 6.1. 推奨アプローチ

第一段階では、次の 2 つを優先すること。

1. **hierarchy-aware resolve**
   - active window
   - owner / modal child
   - direct hwnd
   の優先順位を見直す
2. **common dialog special-case**
   - Save As / Open dialog っぽい top-level / child を owner chain から解決する

### 6.2. 具体的な候補

候補 A:

- `_resolve-window.ts` に common dialog aware な分岐を追加
- `@active` や親 hwnd 解決時に modal child を優先する

候補 B:

- native tool 側 resolver で dialog title に頼らない経路を持つ
- `windowTitle="名前を付けて保存"` 以外にも active child / owner relation を使う

候補 C:

- `desktop_see` target resolution に owner / modal child 探索を入れる

### 6.3. 主に触る可能性が高い箇所

- `_resolve-window.ts`
- `window.ts`
- `desktop.ts`
- `desktop-register.ts`
- `desktop-executor.ts`
- 必要なら `guarded-touch.ts`

---

## 7. やらないこと

このバッチでは次をやらないこと。

- window model 全面刷新
- target spec に大きな breaking change を入れる
- dialog 以外まで広げた resolver rewrite
- negative capability 全面実装
- release / version bump / tag / publish

---

## 8. テスト観点

### 8.1. 最低限確認したいこと

1. common dialog を `windowTitle` だけでなく active / owner から掴めるか
2. parent hwnd 経由で read できるが touch できない連鎖が少しでも減るか
3. V1 resolver が dialog を以前より拾えるか
4. `modal_blocking` の意味を壊さないか

### 8.2. 回す候補

```bash
npm run build
npx vitest run tests/unit/desktop-facade.test.ts tests/unit/desktop-register.test.ts tests/unit/guarded-touch.test.ts
```

必要なら Save As regression 用の unit test を追加してよい。

---

## 9. docs 更新

実装後、必要なら最小限で次を更新してよい。

- [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-backlog.md)
- [anti-fukuwarai-v2-default-on-readiness.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-default-on-readiness.md)
- [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md)
- `desktop_see` / `desktop_touch` / native tool descriptions

---

## 10. 完了条件

このバッチは、次を満たしたら完了でよい。

1. Save As 相当で common dialog の到達率が改善する
2. 以前より guarded path を取りやすくなる
3. build と関連 unit tests が通る
4. 次に negative capability 拡張へ進める土台ができる

---

## 11. 推奨 commit

```text
fix(window): improve common dialog targeting for anti-fukuwarai v2 flows
```
