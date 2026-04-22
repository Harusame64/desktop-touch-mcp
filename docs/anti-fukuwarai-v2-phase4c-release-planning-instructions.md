# Anti-Fukuwarai v2 Phase 4-C Release Planning 指示書

作成: 2026-04-22  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
対象: Phase 4 / Batch P4-C  
目的: G1 + G2 完了後の release planning / packaging review を整理し、ship / hold を判断できる状態を作る

---

## 1. このバッチの目的

P4-A で quality review を終え、P4-B で default-on readiness / rollback policy を整理し、  
続く G1 + G2 実装で production blocker は解消された。

P4-C の役割は、**いま release を実行することではない**。  
ここでやるのは、次の問いに答えられる状態を作ることである。

1. 今の Anti-Fukuwarai v2 は、`default OFF / opt-in` の experimental surface として release に載せてよいか
2. もし載せるなら、versioning / docs / packaging / smoke の観点で何を確認すべきか
3. もしまだ載せないなら、何が no-ship 理由になるか

P4-C のゴールは、**release candidate の判断材料を 1 枚にまとめること**であり、  
`npm version` / `git tag` / `npm publish` / GitHub Release 実行は含まない。

---

## 2. 最初に読むこと

着手前に必ず次を読むこと。

1. [docs/release-process.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/release-process.md)
2. [docs/anti-fukuwarai-v2-experimental-quality-review.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-experimental-quality-review.md)
3. [docs/anti-fukuwarai-v2-default-on-readiness.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-default-on-readiness.md)
4. [docs/anti-fukuwarai-v2-g1-g2-implementation-instructions.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-g1-g2-implementation-instructions.md)
5. [docs/anti-fukuwarai-v2-phase4-instructions.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-phase4-instructions.md)
6. [docs/Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/Anti-Fukuwarai-V2.md)

次に、release planning の対象として最低限次を確認すること。

- [src/server-windows.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/server-windows.ts)
- [src/tools/desktop-register.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-register.ts)
- [package.json](D:/git/desktop-touch-mcp-fukuwaraiv2/package.json)
- [bin/launcher.js](D:/git/desktop-touch-mcp-fukuwaraiv2/bin/launcher.js)
- [scripts/test-http-mcp.ps1](D:/git/desktop-touch-mcp-fukuwaraiv2/scripts/test-http-mcp.ps1)
- [tests/unit/launcher-stdio.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/launcher-stdio.test.ts)
- [tests/unit/tool-descriptions.test.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/tests/unit/tool-descriptions.test.ts)
- [README.md](D:/git/desktop-touch-mcp-fukuwaraiv2/README.md)
- [README.ja.md](D:/git/desktop-touch-mcp-fukuwaraiv2/README.ja.md)

必要なら次も見ること。

- [src/stub-tool-catalog.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/stub-tool-catalog.ts)
- [.github/workflows/release.yml](D:/git/desktop-touch-mcp-fukuwaraiv2/.github/workflows/release.yml)
- [server.json](D:/git/desktop-touch-mcp-fukuwaraiv2/server.json)

---

## 3. 現在地

P4-C 開始時点の前提は次で固定されている。

- `desktop_see` / `desktop_touch` は **experimental として成立**
- `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` による **opt-in 継続**
- default-on は **まだしない**
- V1 tools は migration path / debug path / escape hatch として **残す**
- G1 modal / viewport / focus guard は production wiring 済み
- G2 terminal route は background / WM_CHAR path 優先へ切替済み

つまり P4-C は、**default-on readiness を再議論するフェーズではない**。  
「この experimental surface を次 release にどう載せるか」を決めるフェーズである。

---

## 4. このバッチで決めること

### 4.1. Release outcome

P4-C では、最終的に次の 2 択のどちらが妥当かを判断する。

#### Outcome 1: Ship experimental in release notes

- default OFF 維持
- `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` で使えることを docs / release note に明記
- V1 tools を escape hatch として残す

#### Outcome 2: Hold release

- mainline 上では保持してよい
- ただし次の public release note にはまだ含めない
- no-ship 理由を明文化して次 batch へ送る

P4-C の初期仮説は **Outcome 1 を第一候補** とする。  
ただし packaging / server surface / release flow に新しい blocker が見つかった場合は Hold に倒してよい。

### 4.2. Versioning recommendation

次の 3 つを比較して、どれが妥当かを判断する。

- `patch`
- `minor`
- `pre-release`

初期仮説:

- `default OFF` の experimental surface を release note に載せるなら、**`minor` を第一候補** として検討する
- 既存 release にほぼ影響がなく、内部的改善として扱うなら `patch` も候補
- 外部露出をまだ強く抑えたい場合だけ `pre-release` を候補にする

ここでは version を実際に bump しない。  
**推奨案と理由を書くことが目的**である。

### 4.3. Packaging / rollout plan

次を整理する。

- flag OFF / ON の server surface が release 後も想定どおりか
- launcher / zip / HTTP mode の preflight はどの順で確認するか
- release-process の順序を P4-C の提案にどう落とし込むか
- rollback / kill switch はどこまで release note に書くか

---

## 5. 実施項目

### 5.1. Server surface review

少なくとも次を確認すること。

1. `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2` がない時、`desktop_see` / `desktop_touch` は catalog に出ない
2. flag ON 時だけ V2 tools が公開される
3. tool description が現行の fail / recovery 契約とズレていない
4. V1 tools の escape hatch 方針が docs 上でも明確

必要なら `desktop-register.ts` の wording や docs だけ最小限で補修してよい。  
ただし P4-C は **新しい機能追加フェーズではない**。

### 5.2. Packaging review

少なくとも次を確認すること。

1. dynamic import で読み込む V2 surface が build / dist / zip に乗る想定になっているか
2. launcher / `SERVER_VERSION` / release manifest の整合性に、P4-C で新たな注意点があるか
3. HTTP mode の preflight 手順が current repo state と矛盾していないか
4. release candidate を切るときの確認順が `docs/release-process.md` と一致しているか

P4-C では **zip 作成や publish はしない**。  
「将来の実行手順として妥当か」を見るだけでよい。

### 5.3. Docs / release note planning

最低限、次の文脈を整理すること。

1. Anti-Fukuwarai v2 は release note 上でどう説明するか
2. default OFF / opt-in 継続をどう誤解なく書くか
3. kill switch と V1 fallback をどう短く案内するか
4. `desktop_see` / `desktop_touch` を「使えるが experimental」とどう表現するか

過剰に marketing しないこと。  
**default-on のように誤読される書き方を避ける**こと。

### 5.4. No-ship criteria を明文化する

P4-C では「何なら出さないか」も書くこと。

例:

- packaging 上の不確実性が残る
- tool surface と docs がズレている
- launcher / HTTP mode / smoke 手順に未確認の穴がある
- release note に書く運用説明がまだ曖昧

---

## 6. 非目標

今回やらないこと:

- default-on を有効化する
- `DESKTOP_TOUCH_PREFER_FUKUWARAI_V2` を実装する
- V1 tools を削除する
- `npm version` / `git tag` / `npm publish` / GitHub Release を実行する
- unrelated refactor を広げる

---

## 7. 期待する成果物

最低限ほしい成果物は次の 1 枚。

- `docs/anti-fukuwarai-v2-release-planning-review.md`

その中に、少なくとも次を入れること。

1. 現時点の推奨 release outcome
2. versioning recommendation と理由
3. server surface / packaging / rollout / rollback の要点
4. ship する場合の前提条件
5. hold する場合の理由

必要なら、これに加えて最小限の docs / wording 補修を入れてよい。

---

## 8. 推奨検証

最低限:

```bash
npm run build
npx vitest run tests/unit/desktop-register.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-executor.test.ts tests/unit/tool-descriptions.test.ts tests/unit/launcher-stdio.test.ts
```

tool description や catalog に触れた場合は、必要に応じて次も確認すること。

```bash
npm run check:stub-catalog
```

HTTP preflight の手順そのものを補修した場合は、必要に応じて次を検討してよい。

```powershell
$proc = Start-Process node -ArgumentList "dist/index.js --http --port 23847" -PassThru -WindowStyle Hidden
Start-Sleep 3
pwsh -File scripts/test-http-mcp.ps1 -UseExisting
Stop-Process -Id $proc.Id -Force
```

ただし環境依存で難しければ、**P4-C では手順レビューだけでもよい**。  
実行できなかった場合は、その旨を明記すること。

---

## 9. 判断のガイド

P4-C の結論は、原則として次の順で考えること。

1. G1/G2 が閉じた今、**まずは `Ship experimental in release notes` を第一候補**に置く
2. ただし `default OFF` / opt-in 継続 / V1 escape hatch 維持は絶対に崩さない
3. packaging / launcher / HTTP / docs に release blocker があれば Hold へ倒す

つまり判断軸は次の通り。

- `default-on できるか` ではなく
- `experimental を安全に載せられるか`

---

## 10. 推奨 commit

成果物が docs 中心なら、たとえば次でよい。

```text
docs(release): add anti-fukuwarai v2 release planning and packaging review
```

docs に加えて surface wording を触った場合は、必要に応じて split commit にしてよい。

