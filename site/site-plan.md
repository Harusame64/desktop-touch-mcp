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
- 現在地 (安定して日常運用できる / まだ進化中 / 評価は未完) を誇張なく明記する
- `Beyond Coordinate Roulette` の世界観を短く紹介する
- 深掘り先へのハブになる

読後感:

- 「座標クリックの便利ツールではなく、LLM が外界を安全に扱うための設計なんだな」
- 「今日から使えて、しかも目指している方向が面白い」

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
- project status note
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
desktop-touch-mcp gives LLM agents a safer contract with the outside world.
```

日本語では:

```text
desktop-touch-mcp は、LLM に座標を渡すためのツール集ではなく、
外界とより安全に付き合うための仕組みです。
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

## 8. 現在地の見せ方

Top page では「安定して使える」と「まだ進化中」を両方、誇張も自己卑下もなく見せる。

入れるべき要素:

- 日常運用に耐える段階にあること (安定した tool surface / 定期リリース)
- 新しい面はリリースごとに能力が増えていること
- 評価 (ベンチマーク) はまだ未完で、計画を公開していること

文言案:

```text
Stable enough for daily work, and still moving.
The tool surface is stable and shipping regularly; the newer surfaces keep gaining capability;
systematic evaluation is still being built out, and the plan for it is public.
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
