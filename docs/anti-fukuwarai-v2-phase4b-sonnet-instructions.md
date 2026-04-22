# Anti-Fukuwarai v2 Phase 4-B Sonnet 指示書

作成: 2026-04-22  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
対象フェーズ: Phase 4 / Batch P4-B  
前提資料: `docs/anti-fukuwarai-v2-experimental-quality-review.md`

---

## 1. この指示書の目的

このバッチは **default-on readiness / kill switch 整理** が主題である。  
ここでやるべきことは「V2 を今すぐ default-on にする」ことではない。

Sonnet に期待する成果は次の 3 つ。

1. **activation policy の明文化**
2. **kill switch / rollback policy の明文化**
3. **default-on を見送るなら、その理由と次の gate の明文化**

P4-A の結論はすでに出ている。

- `desktop_see` / `desktop_touch` は experimental としては成立
- ただし default-on 候補としてはまだ早い
- 特に P1 として
  - `desktop_touch` production wiring に modal / viewport / focus 観測が未接続
  - terminal executor が foreground path で focus を奪う

したがって、このバッチの推奨スタンスは **「default-on 実装を進める」のではなく、「なぜ今は default-on しないかを整理し、rollback を簡単に保つ」** である。

---

## 2. 最初に読むこと

作業開始後、まず次を読むこと。

1. [anti-fukuwarai-v2-phase4-instructions.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-phase4-instructions.md)
2. [anti-fukuwarai-v2-experimental-quality-review.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-experimental-quality-review.md)
3. [Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/Anti-Fukuwarai-V2.md)

必要に応じて読む実装ファイル:

- [src/server-windows.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/server-windows.ts)
- [src/tools/desktop-register.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-register.ts)
- [src/tools/desktop.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop.ts)
- [src/tools/desktop-executor.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-executor.ts)

---

## 3. 現在地

P4-A 完了時点で、次は P4-B に入る。

確認済み:

- `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` で experimental surface は出せる
- target 省略時の foreground routing と hwnd-only terminal routing は修正済み
- review note に pass / partial / issue list が整理されている
- `npm run build` と関連 unit tests は通っている

まだ残る論点:

1. 今のまま default-on にしたときの blast radius を許容できるか
2. OFF に戻す導線が十分に分かりやすいか
3. legacy tools を escape hatch としてどう位置づけるか
4. `desktop_see` warnings / `desktop_touch` fail reason の recovery 導線が十分に説明されているか

---

## 4. このバッチで採るべき基本方針

### 4.1. 推奨判断

このバッチでは、まず次の判断を第一候補として扱うこと。

```text
Decision candidate:
  - default-on しない
  - opt-in 継続
  - docs 推奨 + internal dogfooding 継続
```

理由:

- P4-A review で P1 が残っている
- rollback を簡単に保つほうが Phase 4 の判断原則に合う
- default-on のコード変更を先に入れるメリットより、運用面の混乱コストのほうが大きい

### 4.2. 実装を先走らせない

このバッチでやるべきなのは **policy の整理** が中心である。  
大きな code path 変更や default-on 化そのものは、このバッチでは避けること。

### 4.3. kill switch は単純であるほどよい

現時点の real kill switch はこれでよい。

```text
DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1
```

もし `DESKTOP_TOUCH_PREFER_FUKUWARAI_V2=1` を扱うなら、**将来の候補として整理するだけ** に留めること。  
このバッチで default behavior を変える目的で追加しないこと。

---

## 5. 作業スコープ

### やること

1. **activation policy の監査**
   - 現在どこで env flag を見ているか
   - OFF のとき何が露出しないか
   - ON のとき legacy tools とどう共存するか

2. **kill switch / rollback path の監査**
   - OFF に戻せば現行 behavior に戻るか
   - legacy tools だけで通常運用が継続できるか
   - docs と tool description に矛盾がないか

3. **fallback UX の監査**
   - `desktop_see` warnings の next action が説明可能か
   - `desktop_touch` fail reason の recovery が説明可能か

4. **成果物 docs の作成**
   - default-on readiness / rollback policy を 1 枚にまとめる
   - 現時点の推奨判断を曖昧にしない

5. **必要なら最小限の補修**
   - docs と実装の説明がズレる箇所だけを狭く直す
   - 大きな設計変更はしない

### やらないこと

- default-on をコードで有効化する
- `desktop_see` / `desktop_touch` を常時公開へ切り替える
- V1 ツール群を削除する
- npm publish / tag / release を始める
- P1 を全部解決しようとしてバッチを膨らませる

---

## 6. Sonnet への具体的な実施順

### Step 1. activation path の把握

まず次を確認すること。

- `src/server-windows.ts`
- `src/tools/desktop-register.ts`

見たい点:

- env flag OFF で V2 tools が見えないこと
- env flag ON で V2 が追加されること
- legacy surface がそのまま残ること

### Step 2. fallback / rollback の把握

次を確認すること。

- `desktop_see` / `desktop_touch` description
- `desktop_touch` fail reason
- warnings surface
- legacy tool descriptions

見たい点:

- fail した時に「次に何をすればよいか」が user-facing に伝わるか
- V2 が不安定でも V1 へ戻れることが分かるか

### Step 3. readiness policy doc を書く

新規 doc を 1 枚作ること。  
ファイル名は例えば次のいずれかでよい。

- `docs/anti-fukuwarai-v2-default-on-readiness.md`
- `docs/anti-fukuwarai-v2-rollback-policy.md`

おすすめは 1 枚にまとめる形。

含めるべき項目:

1. current decision
2. why not default-on yet
3. current activation policy
4. kill switch
5. rollback path
6. migration / dogfood plan
7. next gates before default-on

### Step 4. 必要なら最小補修

もし監査の結果、description / docs / env behavior の説明にズレがあれば、**狭く**直してよい。

許容される補修の例:

- tool description の wording 修正
- env helper の comment 追加
- docs のリンク整理
- 小さい unit test 追加

避けるべき補修の例:

- activation policy の実質変更
- default-on に見える振る舞い変更
- P1 解消のための大きい wiring 追加

---

## 7. 期待する判断の形

このバッチの終わりには、少なくとも次の 3 択のどれかが読める状態にすること。

```text
1. opt-in 継続 + docs 推奨 + dogfood 継続
2. default-like preference を docs 上で準備するが、実動はまだ opt-in
3. default-on 候補へ進めるには P1 解消が前提なので hold
```

現時点では 1 か 3 が自然である。  
2 を採る場合も、**実コードで default-on に寄せない** こと。

---

## 8. 推奨アウトプット

最低限ほしい成果物:

- readiness / rollback policy doc 1 枚

できればほしい成果物:

- tracking doc からのリンク追加
- env policy / fallback UX の小テスト
- commit message 候補の明記

推奨 commit:

```text
docs(server): define anti-fukuwarai v2 default-on readiness and rollback policy
```

もし tiny code/test も入った場合:

```text
docs(server): define anti-fukuwarai v2 readiness and rollback policy
test(server): lock anti-fukuwarai v2 activation and rollback behavior
```

---

## 9. テスト / 検証方針

docs-only で終わるなら build は不要だが、code / test を触ったら必ず確認すること。

推奨:

```bash
npm run build
npx vitest run tests/unit/desktop-register.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-providers.test.ts
```

もし activation policy や description に触れたなら、関係する unit test を追加してから回すこと。

---

## 10. 完了条件

このバッチは、次を満たしたら完了でよい。

1. 現時点の activation policy が 1 枚で説明できる
2. kill switch と rollback path が明文化されている
3. default-on を見送る理由、または進める前提条件が明文化されている
4. legacy tools を escape hatch として残す方針が書かれている
5. 次に P4-C へ進むか、P1 解消へ戻るかが迷わない

---

## 11. 迷ったときの優先順位

迷ったら次の順で判断すること。

1. rollback が簡単になるほう
2. default-on を遅らせても説明しやすいほう
3. code 変更より docs / tests で片付くほう
4. 今すぐ便利そうでも blast radius が増える変更は避ける

このバッチは「攻める」より「出せる条件を整理する」ための作業である。

