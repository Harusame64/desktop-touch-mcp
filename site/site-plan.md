# GitHub Pages Site Plan

作成: 2026-04-25

この文書は、`desktop-touch-mcp` の GitHub Pages を
**「実験的プロジェクトの入口」** と **「RPG のやさしい詳解」** に分けて設計するためのメモである。

狙いは次の三つ。

1. 初見の読者に「何を目指しているプロジェクトか」を 30 秒で伝える
2. その次に「Reactive Perception Graph とは何か」をやさしく理解してもらう
3. 最後に GitHub / preprint / 実験結果へ自然に流す

---

## 1. サイト全体の役割

GitHub Pages は note の代わりではなく、**一番詳しい本拠地**として使う。

読者導線は次を想定する。

```text
SNS / note / README / GitHub repo
  -> GitHub Pages top
  -> RPG article
  -> code / preprint / experiments
```

このため Pages では、トップページと記事ページの役割を明確に分ける。

---

## 2. 必要なページ

### A. Top page

役割:

- プロジェクトの正体を伝える
- experimental であることを明記する
- `Beyond Coordinate Roulette` の世界観を短く紹介する
- 深掘り先へのハブになる

読後感:

- 「座標クリックの便利ツールではなく、LLM が外界を安全に扱うための実験なんだな」
- 「まだ完成品ではないが、目指している方向は面白い」

### B. RPG article page

役割:

- `Reactive Perception Graph` の考え方を図解で説明する
- なぜ snapshot-and-act が危ないかを直感で伝える
- provisional state / lease / guard を移植可能な形で示す

読後感:

- 「RPG はスクショ節約テクニックではなく、外界との契約の話なんだな」
- 「自分の agent にも応用できそう」

---

## 3. 情報の分担

### Top page に置くもの

- 一言サマリ
- experimental note
- Beyond Coordinate Roulette の話
- なぜこのプロジェクトを作っているのか
- 主要な技術テーマ
- 入口リンク

### RPG article に置くもの

- failure story
- RPG の一文説明
- 4 つの概念
- 実行前フロー
- 汎用コード例
- 実験予定

### README に残すもの

- インストール
- 設定
- tool catalog
- 実運用の使い方

Pages では README の再掲をしない。

---

## 4. ページ間リンク

### Top -> RPG

- ボタン文言案:
  - `Read the RPG explainer`
  - `Why snapshots are not enough`
  - `Reactive Perception Graph を読む`

### RPG -> Top

- パンくずか小さな戻り導線を付ける

### Top / RPG -> Repo

- `GitHub Repository`

### Top / RPG -> Preprint

- `Preprint draft`

### Top / RPG -> Experiments

- `Planned evaluation`

---

## 5. トーンの分担

### Top page のトーン

- 少しプロダクト紹介に近い
- ただし誇張しない
- 「何ができるか」より「何を変えたいか」

### RPG article のトーン

- 先生っぽくなく、図解で納得させる
- 中学生でも情景が浮かぶ
- 専門用語は後から添える

---

## 6. Top page の主メッセージ

このページで持ち帰ってほしい一文はこれ。

```text
desktop-touch-mcp is an experimental project for giving LLM agents
a safer contract with the outside world.
```

日本語では:

```text
desktop-touch-mcp は、LLM に座標を渡すためのツール集ではなく、
外界とより安全に付き合うための実験的プロジェクトです。
```

---

## 7. Beyond Coordinate Roulette の位置づけ

Top page では公開名として `Beyond Coordinate Roulette` を使う。  
`Anti-Fukuwarai` は内部コードネームとしてのみ残す。

伝えたいこと:

- 座標を見てクリックするだけでは、意味のある UI 操作にならない
- 「いま何が見えていて」「何を触ろうとしているか」を semantic に扱いたい
- lease, guard, diff, event-first はそのための部品

短い一言案:

```text
Beyond Coordinate Roulette is the idea that UI automation should move
from coordinate guessing toward meaning-first interaction.
```

---

## 8. 実験的であることの見せ方

Top page では experimental を逃げではなく、方針として見せる。

入れるべき要素:

- これは production-ready をうたうページではない
- 実運用に効く部品と、まだ研究中の部品が混在している
- 評価はこれから継続的に埋める

文言案:

```text
This project is experimental by design.
Some parts are stable and practical today.
Other parts are still being tested as ideas about how LLM agents should touch the world.
```

---

## 9. 最小サイトマップ

```text
/
  index.html                <- top page
  /articles/rpg.html        <- RPG explainer
  /assets/figures/*.svg
  /assets/eval/*.json
```

Markdown 運用なら次でもよい。

```text
docs/pages/index.md
docs/pages/articles/rpg.md
docs/pages/assets/...
```

---

## 10. 先に作るべき順序

1. Top page draft
2. RPG article draft
3. Figure skeletons
4. Evaluation JSON schema
5. note 用の短縮版
