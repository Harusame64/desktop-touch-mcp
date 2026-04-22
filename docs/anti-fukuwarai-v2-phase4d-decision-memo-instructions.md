# Anti-Fukuwarai v2 Phase 4-D Ship / No-Ship Decision Memo 指示書

作成: 2026-04-22  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
対象: Phase 4 / Batch P4-D  
目的: Phase 4 の最終判断を 1 枚の memo に固定し、release 実行へ進むか / hold するかを曖昧なく決める

---

## 1. このバッチの目的

P4-A で experimental quality review、P4-B で readiness / rollback policy、  
G1 + G2 で blocker 解消、P4-C で release planning / packaging review が終わった。

P4-D の役割は、これまでの材料を **最終判断メモ 1 枚** に圧縮すること。  
ここで必要なのは新しい分析を増やすことではなく、**次の release window で何をするかを一意に読める状態にすること**である。

P4-D のゴールは、次のいずれかを明記すること。

1. **Ship experimental in next release**
2. **Hold and continue dogfooding**
3. **Blocked by release gate**

重要:

- P4-D では **願望ではなく、現時点の証拠と gate 状態に基づいて書く**
- `default-on` 判断ではなく、**default OFF experimental を載せるか**を判断する
- 実際の `npm version` / `git tag` / `npm publish` / GitHub Release は行わない

---

## 2. 最初に読むこと

着手前に必ず次を読むこと。

1. [docs/release-process.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/release-process.md)
2. [docs/anti-fukuwarai-v2-experimental-quality-review.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-experimental-quality-review.md)
3. [docs/anti-fukuwarai-v2-default-on-readiness.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-default-on-readiness.md)
4. [docs/anti-fukuwarai-v2-release-planning-review.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-release-planning-review.md)
5. [docs/anti-fukuwarai-v2-phase4c-release-planning-instructions.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-phase4c-release-planning-instructions.md)
6. [docs/anti-fukuwarai-v2-phase4-instructions.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-phase4-instructions.md)
7. [docs/Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/Anti-Fukuwarai-V2.md)

必要に応じて、次も確認してよい。

- [README.md](D:/git/desktop-touch-mcp-fukuwaraiv2/README.md)
- [README.ja.md](D:/git/desktop-touch-mcp-fukuwaraiv2/README.ja.md)
- [src/server-windows.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/server-windows.ts)
- [src/tools/desktop-register.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-register.ts)

---

## 3. 現時点の前提

P4-D 開始時点の前提は次で固定されている。

- `desktop_see` / `desktop_touch` は experimental として成立
- G1 / G2 blocker は閉じている
- default-on はまだしない
- `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` の opt-in を維持する
- V1 tools は escape hatch として残す
- P4-C の推奨 outcome は **Ship experimental in release notes**
- P4-C の推奨 versioning は **`0.16.0` (minor)**

一方で、次の gate は status を確認してから memo に反映すること。

- HTTP preflight 6/6
- README / README.ja の V2 experimental 記述
- release-process.md Phase 1-7 へ進める状態か

つまり P4-D では、

- **完全 Ship**
- **Ship pending final gate**
- **Hold**

のどれかを、明確な条件付きで書き分けること。

---

## 4. このバッチで決めること

### 4.1. Decision

次のいずれかを必ず 1 つ選ぶこと。

#### A. Ship experimental in next release

使う条件:

- release blocker がない
- remaining gate が実施手順レベルの最終確認だけ
- memo を読めば、そのまま release-process.md に接続できる

#### B. Ship pending final gate

使う条件:

- release blocker はない
- ただし HTTP preflight など、release 実行前の最後の確認が未完了
- いまの時点で「方向は Ship、ただし条件付き」と書くのが最も正確

#### C. Hold and continue dogfooding

使う条件:

- docs / packaging / server surface / preflight に不確実性が残る
- P4-C の前提が崩れた
- または新たな issue が見つかった

**現時点の初期仮説は B** とする。  
理由: P4-C では `Ship experimental` が第一候補だが、HTTP preflight 未実施なら memo 上は条件付きにする方が安全だからである。

### 4.2. Why

Decision を支える理由は最低限次を含めること。

1. quality review の結論
2. G1/G2 完了による blocker 解消
3. rollback / kill switch の単純さ
4. packaging / release planning review の結果
5. 残る gate が blocker なのか final gate なのか

### 4.3. Conditions

Decision に紐づく条件を明記すること。

最低限:

- env policy
- versioning recommendation
- ship 前に必要な手順
- hold に倒す条件
- rollback 方法

---

## 5. 期待する成果物

最低限ほしい成果物は次の 1 枚。

- `docs/anti-fukuwarai-v2-ship-decision-memo.md`

構成は、次に近い形を推奨する。

```text
Decision
Why
Current Gate Status
Conditions to Ship
Conditions to Hold
Rollback / Kill Switch
Next Action
```

### 5.1. 必ず入れること

#### Decision

- 一文で結論が読めること
- `Ship`, `Ship pending final gate`, `Hold` のどれかを曖昧なく書くこと

#### Why

- P4-A / P4-B / G1+G2 / P4-C の要約が短く入っていること

#### Current Gate Status

- 少なくとも HTTP preflight, README, release flow readiness を並べること

#### Rollback / Kill Switch

- `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` を外して再起動すれば V1 に戻れること

#### Next Action

- 次に何を実行すればよいかが 2-4 行で読めること

---

## 6. 書き方のルール

### 6.1. 誤解を招かない

避けること:

- `desktop_see` / `desktop_touch` が既定で有効になるように読める表現
- V1 より全面的に優れていると断定する表現
- HTTP preflight 未実施なのに unconditional ship と書くこと

使ってよい表現:

- `default OFF`
- `opt-in experimental`
- `V1 tools remain available as escape hatch`
- `Ship pending HTTP preflight`

### 6.2. 願望ではなく判定

メモは planning 文書ではなく **decision 文書** である。  
「今後検討する」より、「現時点ではこう判断する」を優先すること。

### 6.3. release 実行までは入らない

この batch の成果は memo であり、release 作業そのものではない。

---

## 7. 推奨検証

memo だけなら追加コード変更は不要なはずだが、docs や wording を触るなら最低限次を確認してよい。

```bash
npm run build
npx vitest run tests/unit/tool-descriptions.test.ts tests/unit/launcher-stdio.test.ts tests/unit/desktop-register.test.ts
```

HTTP preflight をこの batch で実施するかは任意。  
もし実施したなら、memo に結果を必ず反映すること。

```powershell
$proc = Start-Process node -ArgumentList "dist/index.js --http --port 23847" -PassThru -WindowStyle Hidden
Start-Sleep 3
pwsh -File scripts/test-http-mcp.ps1 -UseExisting
Stop-Process -Id $proc.Id -Force
```

実施しない場合は、**未実施であること自体を decision 条件に残す**こと。

---

## 8. 非目標

今回やらないこと:

- default-on を有効化する
- `DESKTOP_TOUCH_PREFER_FUKUWARAI_V2` を実装する
- V1 tools を削除する
- `npm version` / `git tag` / `npm publish` / GitHub Release を実行する
- release note 本番文面を過剰に広げる

---

## 9. 完了条件

P4-D 完了時点で次を満たすこと。

1. ship / no-ship が memo だけで一意に読める
2. rollback 方法が memo に明記されている
3. final gate が何か分かる
4. 次アクションが曖昧でない

この状態になれば、次は

- final gate 実行後に release に進む
- もしくは hold して次 batch に戻す

のどちらかを迷わず選べる。

---

## 10. 推奨 commit

docs 中心なら、たとえば次でよい。

```text
docs(facade): record anti-fukuwarai v2 ship decision for next release window
```

