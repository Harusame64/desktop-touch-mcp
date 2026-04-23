# Anti-Fukuwarai v2 — Default-On Rollout Plan

作成: 2026-04-23  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
目的: `desktop_see` / `desktop_touch` を opt-in experimental から標準公開へ進めるための、現時点のハードルと次タスクを整理する

---

## 1. 結論

`desktop_see` / `desktop_touch` を **技術的に標準公開へ切り替えること自体** は難しくない。  
本当にハードルになっているのは、**default-on 時の運用設計と rollback 設計がまだ弱いこと**である。

現時点の整理:

- **解消済み**
  - G1: modal / viewport / focus の production guard
  - G2: terminal background / WM_CHAR path
  - build / tests / HTTP preflight / packaging review
- **未解消**
  - default-on 用 activation policy
  - default-on 時の kill switch / rollback policy
  - V1 / V2 共存 UX
  - dogfood evidence の薄さ
  - optional quality debt (visual attach race, cdpPort)

したがって、次の焦点は **「品質実装」ではなく「標準公開のための surface / policy / rollout 設計」** である。

---

## 2. いま本当に残っているハードル

## 2.1. Activation policy の作り替え

**P4-E Batch A 決定: Option A — disable flag 方式を採択。**

詳細仕様: [`anti-fukuwarai-v2-activation-policy.md`](anti-fukuwarai-v2-activation-policy.md)

- v0.17.0 で `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` を kill switch にして default-on 切替
- `DISABLE=1` と `ENABLE=1` が両立する場合は DISABLE が優先（DISABLE wins）
- `ENABLE=1` は v0.17.x で deprecated 互換受理、v0.18+ で完全撤去
- `"1"` 以外の値は未設定扱い（exact-match semantics 継続）
- 実装差分（`=== "1"` → `!== "1"` 反転）は Batch B で実施

（旧検討案: Option B/C は却下済み。理由は activation-policy.md §6 参照）

---

## 2.2. Kill switch / rollback の再設計

現状の rollback は非常に単純:

- `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` を削除
- サーバー再起動

default-on にするとこの単純さが消える。  
そのため、**逆向き kill switch** を先に決める必要がある。

候補:

```text
DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1
```

または

```text
DESKTOP_TOUCH_TOOL_SURFACE=expert
DESKTOP_TOUCH_V2_SURFACE=off|on|auto
```

要件:

- docs で短く説明できる
- client config から即座に OFF に戻せる
- V1 tools の運用を壊さない
- 再インストール不要

---

## 2.3. V1 / V2 共存 UX

default-on にすると、catalog 上で次の判断が常時発生する。

- V1 screenshot / click 系を使うべきか
- V2 desktop_see / desktop_touch を使うべきか
- 失敗時にどちらへ戻るべきか

いまの stable 側では `tool surface reduction` により core / expert 分離を進めている。  
この流れと無関係に V2 だけ default-on にすると、**公開面が再び増えて LLM 選択コストが上がる**。

したがって、default-on へ進めるなら少なくとも次のどちらかが必要。

1. stable core surface に V2 をどう載せるか決める
2. V1 / V2 の優先順位を instructions / docs で明示する

---

## 2.4. Dogfood evidence の不足

P4 系 docs でも、dogfood 実録は「あると安心」ではなく、  
**default-on に踏み切るための判断材料**として不足している。

最低限ほしいもの:

1. browser form 入力
2. browser button click
3. terminal command send
4. native dialog handling
5. visual-only target

各シナリオでほしい観点:

- `desktop_see` / `desktop_touch` の往復数
- warning / fail reason の解釈しやすさ
- V1 fallback へ戻る導線
- user-facing な違和感の有無

---

## 2.5. Optional quality debt

**P4-E Batch A 決定:**

### A. visual attach race → **やる（Batch B 必須）**

- 初回 `desktop_see` で `visual_provider_unavailable`（backend 未 attach）または `visual_provider_warming`（attach 済み・warm 前）が出うる
- default-on だと warning noise が「V2 は信頼できない」という LLM 学習を作る
- 対処: `desktop-register.ts` で **`visual_provider_unavailable` または `visual_provider_warming`** 検出時に ~200ms 待機 + 1 回 retry
- retry 上限 1 回。retry 後も同警告が出る場合は現行の warnings[] と同等（structured lane で継続可能）
- **Batch B で実装する（G4 necessary gate）**

### B. browser `9222` 固定前提 → **やらない（deferred）**

- V2 `TargetSpec` に `cdpPort` がないため、非 9222 port の Chrome/Edge では browser lane が機能しない
- 非 9222 ポートは advanced user であり、docs で「`--remote-debugging-port=9222` 前提」を明記すれば自己解決可能
- 注: V1 `browser_*` は `desktop-touch-config.json` の `{ "cdpPort": N }` で非 9222 対応済み。ただし V2 内部の browser-provider がこの config を読むかは未確認（`TargetSpec` 経由では非対応）
- V2 の cdpPort 対応は API surface 変更を伴うため、default-on 直前に設計するより実使用で要望が来てから正しい形で実施する
- API surface 変更を default-on 直前に入れるより、実使用で要望が来てから正しい形で設計する
- **G5 deferred: default-on 後に要望ベースで実施**

---

## 3. 次にやるべき具体タスクリスト

優先順は次。

### Task 1. default-on activation / disable policy を設計する

決めること:

- default をどう変えるか
- 何を disable flag にするか
- exact-match semantics をどう扱うか
- top-level dynamic import をどう残すか

成果物:

- docs 1 枚
- 最小実装案
- env matrix

### Task 2. kill switch / rollback UX を docs + code に落とす

決めること:

- client config でどう OFF に戻すか
- default-on 時の kill switch 名
- README / release note での書き方

成果物:

- rollback policy 更新
- server startup log / docs wording の整合

### Task 3. dogfood log を 3-5 本そろえる

追加先候補:

- `docs/anti-fukuwarai-v2-dogfood-log.md`

最低限:

- browser 2
- terminal 1
- native 1
- visual 1

### Task 4. V1 / V2 coexistence policy を決める

決めること:

- default instructions で V2 をどう案内するか
- V1 fallback をどこまで強く残すか
- stable core/expert surface との整合

### Task 5. optional debt を最小修正する

候補:

- visual attach race の first-call retry / async init
- `TargetSpec.cdpPort` 追加

---

## 4. おすすめの進め方

最短で default-on readiness に近づくなら、次の 3 batch がよい。

### Batch A. Activation / rollback / coexistence design（docs のみ）

✅ **完了（2026-04-23）**

成果物:
- [`anti-fukuwarai-v2-activation-policy.md`](anti-fukuwarai-v2-activation-policy.md) — Option A 決定・env matrix
- [`anti-fukuwarai-v2-coexistence-policy.md`](anti-fukuwarai-v2-coexistence-policy.md) — priority order・V1 fallback 対応表
- [`anti-fukuwarai-v2-dogfood-log.md`](anti-fukuwarai-v2-dogfood-log.md) — 5 シナリオ skeleton・合格ライン
- `anti-fukuwarai-v2-default-on-readiness.md` 更新（G3/G4 格上げ、G5 deferred）
- `anti-fukuwarai-v2-default-on-rollout-plan.md` 更新（本ファイル）

### Batch B. 実装 + Instructions 更新

やること:
- `server-windows.ts`: `DISABLE=1` kill switch 実装（`=== "1"` → `!== "1"`）
- `desktop-register.ts`: visual attach race の first-call retry（1 回 ~200ms）
- README / server instructions: priority order 更新、reason → V1 fallback 対応表
- 検証: `npm run build` + vitest + HTTP preflight

### Batch C. Dogfood 実録 + Final Decision

やること:
- 5 シナリオ実録（`anti-fukuwarai-v2-dogfood-log.md` に記入）
- 合格ライン 5 点チェック
- v0.17.0 default-on 切替可否の最終判断メモ

---

## 5. 判断ライン

default-on に進める最低ラインは次。

1. disable flag が定義されている
2. rollback が 1-2 行で説明できる
3. dogfood 実録が 3-5 本ある
4. V1 fallback policy が docs に明記されている
5. optional debt の扱いを「やる / やらない」で決めている

この 5 つが揃えば、`desktop_see` / `desktop_touch` を標準公開候補として再判定しやすい。

---

## 6. 結論

いまのハードルは「V2 の品質が足りない」ではなく、

- **どう標準公開するか**
- **どう止めるか**
- **V1 とどう共存させるか**

の 3 点である。

そのため、次にやるべきは大きな実装追加ではなく、

1. activation / rollback policy
2. dogfood evidence
3. coexistence policy

を固めることである。

