# Anti-Fukuwarai v2 — Batch H2 Negative Capability Surfacing 実装指示書

作成: 2026-04-23  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
対象: post-Go hardening の次バッチ  
目的: `desktop_see` / `desktop_touch` の response に「できないこと」「使えない provider」「fallback すべき理由」を structured に載せ、LLM の誤推論を減らす

---

## 1. このバッチの目的

H4 までで、`visual lane がなぜ上がらなかったか` の説明はかなり改善した。  
次はそれを一段広げて、dogfood で見えた次の friction を structured に返せるようにする。

1. terminal textbox が見えても type できない
2. `desktop_see` が 0 entities を返すと、LLM が「空画面」と誤解しやすい
3. CDP なし / UIA blind / visual 未発動 / terminal read-only などが notes にしか出ない
4. dialog / owned popup / multi-tab など、window hierarchy 残件の「なぜ失敗したか」が見えにくい

このバッチの目的は、window hierarchy そのものを全部直すことではない。  
**まずは negative capability を返して、LLM が次の fallback を選びやすい状態を作ること**が目的である。

---

## 2. 最初に読むこと

着手前に、次を読むこと。

1. [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-backlog.md)
2. [dogfood-incident-report.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/dogfood-incident-report.md)
3. [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md)
4. [anti-fukuwarai-v2-hardening-implementation-instructions.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-implementation-instructions.md)
5. [Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/Anti-Fukuwarai-V2.md)

次に、実装対象として最低限これを読むこと。

- [src/engine/world-graph/types.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/types.ts)
- [src/engine/world-graph/resolver.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/resolver.ts)
- [src/engine/world-graph/candidate-ingress.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/candidate-ingress.ts)
- [src/engine/world-graph/terminal-ingress.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/terminal-ingress.ts)
- [src/engine/world-graph/visual-ingress.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/visual-ingress.ts)
- [src/tools/desktop.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop.ts)
- [src/tools/desktop-register.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-register.ts)
- [src/tools/desktop-providers/compose-providers.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/compose-providers.ts)
- [src/tools/desktop-providers/terminal-provider.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/terminal-provider.ts)

テスト候補:

- [tests/unit/desktop-facade.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-facade.test.ts)
- [tests/unit/desktop-providers.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-providers.test.ts)
- [tests/unit/desktop-register.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-register.test.ts)
- [tests/unit/desktop-executor.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-executor.test.ts)

---

## 3. 現在地

H3 で Save As の common dialog reachability は改善したが、なお次の問題は残る。

- 「見えているが操作不可」
- 「0 entities だが、empty ではなく blind / unavailable」
- 「fallback すべきだが、その理由が operator に見えない」

したがって今回は、**fixability より explainability** を優先する。

---

## 4. 実装方針

### 4.1. view-level constraints を先に出す

全部を entity に積むより、まずは view に次のような制約を返す方が実装しやすい。

- `uia_blind`
- `cdp_unavailable`
- `visual_not_attempted`
- `visual_attempted_empty`
- `terminal_read_only`
- `dialog_like_target`
- `owned_popup_present`

名称はそのままでなくてよいが、**LLM が fallback 判断に使える粒度**にすること。

### 4.2. entity-level capability は軽く始める

必要なら entity にも最小限の capability を足してよい。

例:

- `canClick`
- `canType`
- `preferredExecutors`
- `unsupportedExecutors`

ただし、このバッチで exhaustive modeling を目指さないこと。

### 4.3. warning / fail reason と混同しない

negative capability は、warning / fail reason とは別軸である。  
次の違いを壊さないこと。

- `warning`: 今回の see / provider 実行中に起きたこと
- `fail reason`: touch が失敗した理由
- `capability / constraint`: そもそもこの target で何が難しいか

---

## 5. 期待する到達点

このバッチで最低限ほしい状態:

1. `desktop_see` の response だけで fallback 判断がしやすくなる
2. terminal / PWA / Electron / dialog 周辺で「empty ではなく constrained」と分かる
3. `executor_failed` や entity zero の opaque failure が減る
4. 既存 warning / fail reason contract は壊さない

---

## 6. 実装候補

### 6.1. 推奨アプローチ

第一段階では、次の 2 層を目指すこと。

1. **view-level constraints**
   - provider 単位の blind / unavailable / read-only / fallback suggestion
2. **entity-level hints**
   - 必要最小限の `canType` / `canClick` / executor hint

### 6.2. 具体候補

候補 A:

- `DesktopSeeOutput` に `constraints` または `capabilities` セクションを追加
- `warnings[]` とは別で返す

候補 B:

- entity に `capabilities` を足し、terminal textbox などに `canType=false` を持たせる

候補 C:

- `desktop_register` description に新 constraint / capability の recovery hint を足す

### 6.3. 主に触る可能性が高い箇所

- `types.ts`
- `resolver.ts`
- `candidate-ingress.ts`
- `terminal-ingress.ts`
- `visual-ingress.ts`
- `desktop.ts`
- `desktop-register.ts`

---

## 7. やらないこと

このバッチでは次をやらないこと。

- capability schema の全面設計し直し
- warning / fail reason の全面 rename
- window hierarchy そのものの全面修正
- release / version bump / tag / publish

---

## 8. テスト観点

### 8.1. 最低限確認したいこと

1. terminal textbox に `canType=false` 相当が出せるか
2. `desktop_see` 0 entities でも blind / unavailable 情報が残るか
3. visual / CDP / UIA の unavailable 情報が additive に出るか
4. tool description sentinel が更新されるか

### 8.2. 回す候補

```bash
npm run build
npx vitest run tests/unit/desktop-facade.test.ts tests/unit/desktop-providers.test.ts tests/unit/desktop-register.test.ts tests/unit/desktop-executor.test.ts
```

必要なら capability 専用 test を新設してよい。

---

## 9. docs 更新

実装後、必要なら最小限で次を更新してよい。

- [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-backlog.md)
- [anti-fukuwarai-v2-default-on-readiness.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-default-on-readiness.md)
- [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md)
- `desktop_see` / `desktop_touch` description

---

## 10. 完了条件

このバッチは、次を満たしたら完了でよい。

1. negative capability / constraints が response に見える
2. 0 entities / executor_failed の意味が以前より読める
3. build と関連 unit tests が通る
4. その次に H5-H7 個別 patch へ進める状態になる

---

## 11. 推奨 commit

```text
feat(facade): surface negative capability hints in desktop_see responses
```
