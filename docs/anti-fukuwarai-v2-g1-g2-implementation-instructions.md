# Anti-Fukuwarai v2 Gate G1/G2 実装指示書

作成: 2026-04-22  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
対象: Phase 4 継続バッチ（P4-B 後の blocker 解消）  
目的: `G1` と `G2` をまとめて解消し、P4-C へ進める状態を作る

---

## 1. このバッチの目的

P4-B で、default-on は見送るという判断が確定した。  
その理由になっている必須 blocker は次の 2 件である。

1. **G1 / P1-1**  
   `desktop_touch` production facade に modal / viewport / focus guard が未接続
2. **G2 / P1-2**  
   terminal executor が foreground path で focus を奪う

このバッチの目的は、**default-on を有効化することではない**。  
まずは上の 2 件を実装で潰し、P4-C (Release Planning) に進む前提条件を満たすことが目的である。

---

## 2. 最初に読むこと

着手前に、必ず次を読むこと。

1. [anti-fukuwarai-v2-default-on-readiness.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-default-on-readiness.md)
2. [anti-fukuwarai-v2-experimental-quality-review.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-experimental-quality-review.md)
3. [anti-fukuwarai-v2-phase4-instructions.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/anti-fukuwarai-v2-phase4-instructions.md)
4. [Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/Anti-Fukuwarai-V2.md)

次に、実装対象として最低限次を読むこと。

- [src/engine/world-graph/guarded-touch.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/guarded-touch.ts)
- [src/engine/world-graph/session-registry.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/session-registry.ts)
- [src/tools/desktop.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop.ts)
- [src/tools/desktop-executor.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-executor.ts)
- [src/tools/terminal.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/terminal.ts)
- [src/engine/bg-input.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/bg-input.ts)

必要に応じて参照する helper:

- [src/tools/_focus.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/_focus.ts)
- [src/utils/viewport-position.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/utils/viewport-position.ts)
- [src/tools/context.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/context.ts)

---

## 3. 現在地

P4-B の判断は次で固定されている。

- `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` による opt-in 継続
- default-on はまだしない
- legacy V1 tools は escape hatch として残す

P4-C に進む条件は、少なくとも次の 2 つを満たすこと。

- **G1** `desktop_touch` facade で modal / viewport / focus に関する production guard が効く
- **G2** terminal executor が foreground focus を奪わず background path を優先できる

このバッチでは release planning や versioning には入らないこと。

---

## 4. 実装方針の大原則

### 4.1. 最小の仕組みで blocker を潰す

理想的な大改造ではなく、**既存 helper を reuse して最小の production wiring を入れる** 方針を採ること。

### 4.2. `guarded-touch` の安全性を壊さない

[guarded-touch.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/guarded-touch.ts) には次の制約がある。

- lease validation と execute の間に不要な await を増やさない
- stale lease safe fail を壊さない
- 既存の `reason` / `diff` contract を壊さない

`TouchEnvironment` の署名変更が必要ならしてよいが、**validate → execute の safety comment を破る場合は理由を明記し、最小範囲に留める** こと。

### 4.3. V1 との escape hatch を維持する

このバッチでも V1 tools は消さない。  
V2 が失敗したときに、引き続き V1 へ戻れることを前提に実装する。

---

## 5. G1 の実装対象

### 5.1. 目的

`desktop_touch` の `modal_blocking` / `entity_outside_viewport` / `focus_shifted` を、  
テスト専用ではなく **production facade でも意味のある signal** として扱えるようにする。

### 5.2. 最低限満たすべきこと

#### A. modal guard

- `isModalBlocking` が production で常に `false` にならないこと
- 少なくとも native window に対して、明らかな modal / dialog / overlay を blocking と判定できること
- blocking 時は `desktop_touch` が `ok:false, reason:\"modal_blocking\"` を返すこと

#### B. viewport guard

- `isInViewport` が production で常に `true` にならないこと
- entity rect と target window / viewport から、少なくとも `in-view` かどうかを判定できること
- out-of-view 時は `desktop_touch` が `ok:false, reason:\"entity_outside_viewport\"` を返すこと

#### C. focus signal

- production でも `focus_shifted` が出せる経路を持つこと
- ただし focus は **hard block ではなく、まずは diff / observability 強化でもよい**
- 少なくとも「focus を観測できないから常に未実装」の状態からは脱すること

### 5.3. 推奨実装の考え方

#### modal

まずは既存の安い signal を使うこと。

- 既存 Win32 / UIA の情報
- `get_context` 相当の modal heuristic
- target window に対する top-level window / dialog の関係

このバッチでは lens/perception を全面統合する必要はない。  
**minimum viable guard** でよい。

#### viewport

`rect` がある entity について、まずは target window rect を基準にした判定でよい。

- full scroll container 認識までは求めない
- browser / native / visual-only で共通に使える「明らかに window 外かどうか」の guard を先に入れる

`computeViewportPosition()` など既存 helper の reuse を優先すること。

#### focus

focus は最初から完璧を求めない。優先順位は次の通り。

1. execute 後に focus が他要素へ移ったことを best-effort で観測できる
2. 観測できた場合だけ `focus_shifted` を返す
3. 観測不能時は silent pass ではなく、少なくともコード上で「観測しようとしている」状態にする

focus は、`getFocusedElement()` / `getFocusedAndPointInfo()` / `_focus.ts` の再利用を優先すること。

### 5.4. 設計上の注意

- `TouchEnvironment` を async 化する場合、`validate()` と `execute()` の間の await 追加に注意
- modal / viewport は pre-touch check として機能すること
- focus は diff signal でもよいが、既存 contract を壊さないこと
- `reason` の追加や変更は最小限にする

---

## 6. G2 の実装対象

### 6.1. 目的

[desktop-executor.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-executor.ts) の terminal route を、  
foreground focus 奪取ではなく **background / WM_CHAR path 優先** に切り替える。

### 6.2. 最低限満たすべきこと

- terminal executor が、Windows Terminal / conhost / PowerShell 系で background path を使えること
- `desktop_touch` 経由の terminal send が、可能な限り focus を奪わないこと
- background unsupported な相手には、安全に fallback または fail すること

### 6.3. 推奨実装の考え方

新規実装を作り直すのではなく、**`terminal_send` の background path を reuse** する方針を優先すること。

候補:

- [src/tools/terminal.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/terminal.ts) の `terminalSendHandler`
- [src/engine/bg-input.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/bg-input.ts) の
  - `canInjectViaPostMessage()`
  - `postCharsToHwnd()`
  - `postEnterToHwnd()`
  - `isBgAutoEnabled()`

### 6.4. 実装の期待値

理想:

- `desktop_touch` terminal route が background path を使って `ExecutorKind:\"terminal\"` を返す
- foreground focus を奪わない

最低ライン:

- background path 対応 terminal では focus を奪わない
- unsupported window に対しては無言で foreground へ落ちない
- fallback するなら明示的であること

### 6.5. 避けること

- `desktop-executor.ts` の terminal route を今の foreground pathのまま残すだけ
- unsupported path で silently focus steal する fallback
- clipboard 前提の background paste を入れること

---

## 7. 実装順の推奨

次の順で進めること。

1. **G2 から先に小さく通す**
   - terminal background path は既存実装 reuse の余地が大きく、効果が分かりやすい
2. **次に G1 の modal / viewport**
   - pre-touch blocking を先に production wiring する
3. **最後に G1 の focus**
   - observability / diff を壊さず追加する

理由:

- G2 は blast radius が比較的読みやすい
- G1 は focus の設計分岐があるため、modal / viewport を先に片付けると整理しやすい

---

## 8. 推奨テスト

最低限、次のどれかではなく **まとめて** 確認すること。

### G1

- `desktop_touch` が production wiring 経由で `modal_blocking` を返す unit test
- `desktop_touch` が production wiring 経由で `entity_outside_viewport` を返す unit test
- focus 変化を production wiring 経由で `focus_shifted` として観測できる unit test

### G2

- terminal executor が background path を使う unit test
- background supported window で focus APIs / `keyboard.type()` を使わない test
- unsupported な対象での fallback / fail behavior test

### 回す候補

```bash
npm run build
npx vitest run tests/unit/guarded-touch.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-executor.test.ts tests/unit/desktop-register.test.ts
```

必要なら新規 test file を追加してよい。

---

## 9. やらないこと

このバッチでは次をやらないこと。

- default-on を有効化する
- `DESKTOP_TOUCH_PREFER_FUKUWARAI_V2` を実働フラグとして導入する
- release planning / packaging review に入る
- npm publish / tag / release を始める
- V1 tools を削除する

---

## 10. 成果物

最低限ほしいもの:

1. G1 実装
2. G2 実装
3. 関連 unit tests
4. build / test 結果

できればほしいもの:

- readiness doc への軽い追記
- 「G1/G2 が閉じた」と判断できる short memo

---

## 11. 完了条件

このバッチは、次を満たしたら完了でよい。

1. production facade で modal / viewport が実際に blocking する
2. focus について、少なくとも best-effort で production signal が出る
3. terminal executor が background path 優先になり、focus steal が大きく減る
4. build と関連 unit tests が通る
5. P4-C に進めるかどうかを再判定できる

---

## 12. 推奨 commit

分けるなら次の 2 つが自然。

```text
feat(facade): wire production modal viewport and focus guards for desktop_touch
feat(executor): switch terminal desktop_touch path to background send when supported
```

1 本にまとめるなら:

```text
feat(facade): close anti-fukuwarai v2 G1/G2 blockers before release planning
```

