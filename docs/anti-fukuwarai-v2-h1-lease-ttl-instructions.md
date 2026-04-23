# Anti-Fukuwarai v2 — Batch H1 Lease / TTL Hardening 実装指示書

作成: 2026-04-23  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
対象: post-Go hardening の最初の実装バッチ  
目的: `desktop_see -> desktop_touch` 間の `lease_expired` を減らし、browser-form / terminal の成功率を上げる

---

## 1. このバッチの目的

dogfood では、特に次のシナリオで `lease_expired` が実害になった。

1. **S1 browser-form**
   - `view=explore` の大きい応答を読んでいる間に lease が切れる
2. **S3 terminal**
   - `desktop_see` 直後の LLM 処理時間で TTL を超える

このバッチの目的は、TTL を雑に一律延長することではない。  
**response-size aware TTL** により、「軽い view は現状に近く」「重い `explore` は少し長く持つ」状態へ寄せることが目的である。

---

## 2. 最初に読むこと

着手前に、次を読むこと。

1. [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-backlog.md)
2. [dogfood-incident-report.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/dogfood-incident-report.md)
3. [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md)
4. [anti-fukuwarai-v2-hardening-implementation-instructions.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-implementation-instructions.md)
5. [Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/Anti-Fukuwarai-V2.md)

次に、実装対象として最低限これを読むこと。

- [src/engine/world-graph/session-registry.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/session-registry.ts)
- [src/engine/world-graph/lease-store.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/lease-store.ts)
- [src/engine/world-graph/guarded-touch.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/guarded-touch.ts)
- [src/engine/world-graph/types.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/types.ts)
- [src/tools/desktop.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop.ts)

テスト候補:

- [tests/unit/guarded-touch.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/guarded-touch.test.ts)
- [tests/unit/desktop-facade.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-facade.test.ts)
- [tests/unit/desktop-providers.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/desktop-providers.test.ts)

---

## 3. 現在地

`v0.17.0` の default-on 判定は **Go** に到達している。  
したがって、このバッチは release blocker 解消ではなく、**post-Go quality hardening** である。

ただし、`lease_expired` は本命シナリオに直接効いているため、hardening の最優先に位置づける。

---

## 4. 実装方針

### 4.1. 第一候補は response-size aware TTL

まずは次を入力として TTL を決める設計を検討すること。

- `view` (`action` / `explore` / `debug`)
- entity count
- response payload の大きさに相当する指標

理想は payload size だが、実装負荷が高い場合は **entity count + view** でもよい。

### 4.2. 一律延長は避ける

すべての lease TTL を大幅に伸ばすと、stale lease が残りやすくなる。  
そのため、次のような差をつける方向を優先すること。

- `action` view: 現状維持または最小限の増加
- `explore` view: entity 数が多い時のみ加算
- `debug` view: operator 用なので少し長めでもよい

### 4.3. safety contract を壊さない

次は維持すること。

- `lease_generation_mismatch`
- `lease_digest_mismatch`
- stale lease safe fail
- `validate -> execute` の安全性

TTL を延ばしても、stale lease を通す方向へ寄せてはいけない。

---

## 5. 期待する到達点

このバッチで最低限ほしい状態:

1. S1 / S3 相当のケースで `lease_expired` が以前より起きにくい
2. `action` view の軽いケースでは TTL を過剰に伸ばさない
3. stale lease が通って誤操作する回帰がない
4. docs / tests から TTL policy の意図が読める

---

## 6. 実装候補

### 6.1. 推奨アプローチ

1. lease 発行箇所で TTL policy 関数を 1 つにまとめる
2. `view` と entity 数を元に TTL を算定する
3. 将来的に payload size や operator mode を足せる形にする

例としては、次のような責務分離が自然。

- `computeLeaseTtlMs(...)`
- `issueLease(...)`
- `validateLease(...)`

### 6.2. 触る可能性が高い箇所

- `session-registry.ts`
  - lease 発行経路
- `lease-store.ts`
  - TTL 保持 / expiry 判定
- `types.ts`
  - 必要なら lease metadata の最小追加
- `desktop.ts`
  - `desktop_see` view 情報の伝搬

### 6.3. まだやらないこと

- touch-side grace period
- automatic lease refresh
- `desktop_see + desktop_touch` の 1 call 化
- protocol redesign

これらは別バッチで検討すること。

---

## 7. テスト観点

### 7.1. 追加・更新したいこと

1. `action` view より `explore` view の TTL が長いこと
2. entity 数が大きいほど TTL が加算されること
3. 期限切れ判定は従来通り機能すること
4. generation / digest mismatch は TTL に関係なく reject されること

### 7.2. 回す候補

```bash
npm run build
npx vitest run tests/unit/guarded-touch.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-providers.test.ts
```

必要なら TTL 専用 test を追加してよい。

---

## 8. docs 更新

実装後、必要なら最小限で次を更新してよい。

- [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-hardening-backlog.md)
- [anti-fukuwarai-v2-default-on-readiness.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-default-on-readiness.md)
- [anti-fukuwarai-v2-dogfood-log.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-dogfood-log.md)

ただし docs 更新は補助であり、今回の主目的は TTL policy の実装である。

---

## 9. やらないこと

このバッチでは次をやらないこと。

- release 作業
- `npm version`
- `git tag`
- `npm publish`
- visual lane の実装変更
- common dialog hardening
- negative capability surfacing

---

## 10. 完了条件

このバッチは、次を満たしたら完了でよい。

1. response-size aware TTL が導入されている
2. `lease_expired` の dogfood 再現率が下がる設計になっている
3. stale lease safety を壊していない
4. build と関連 unit tests が通る

---

## 11. 推奨 commit

```text
feat(facade): make desktop touch leases aware of large explore responses
```
