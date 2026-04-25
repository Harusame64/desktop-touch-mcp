# V2 Main Migration Checklist

作成: 2026-04-25  
対象リポジトリ: `desktop-touch-mcp`  
目的: 研究ブランチの成果をいつ `main` に戻すかを、感覚ではなくチェックリストで判断できるようにする

---

## 1. 前提

このブランチの役割は、主に次の 2 つである。

1. `desktop_see` / `desktop_touch` を含む v2 系の公開面整理
2. detector / OCR / visual lane / LLM 選定の研究

ただし `main` に戻すタイミングは、研究テーマ全体の完了を待つ必要はない。  
先に `main` に戻す価値があるのは、**土台として独立価値を持つ部分**である。

この文書では、`main` に移す判断を次の原則で固定する。

- `main` は配布・保守・dogfood を優先する
- 研究ブランチは性能上限・モデル選定・将来の publishable work を優先する
- detector の最終勝者が未確定でも、土台が整っていれば `main` へ進めてよい

---

## 2. Main に戻す対象

`main` に先行移植する対象:

- tool surface の `core / expert` 整理
- stable な runtime / registration / catalog 配線
- visual lane の足回り
- 画像取得、dirty rect、VRAM 経由の dataplane
- Rust backend の器
- WinOCR を使った最低限の OCR lane
- LLM に渡す provider / facade / candidate composition の基盤

研究ブランチに残してよい対象:

- detector の本命選定
- OmniParser / Florence-2 / 自前 fine-tune 比較
- multi-engine OCR
- token-efficient DSL
- state classifier / relationship inference
- Hugging Face / 論文化 / 公開モデル戦略

---

## 3. Main 移行ゲート

以下 4 ゲートのうち、**Gate A と Gate B は必須**。  
**Gate C は原則必須**。  
**Gate D は推奨だが、研究継続を優先して branch 残留でもよい。**

### Gate A. Tool Surface 整理

- [ ] `core` / `expert` の surface 方針が確定している
- [ ] `DESKTOP_TOUCH_TOOL_SURFACE` で surface を切り替えられる
- [ ] runtime registration が mode-aware になっている
- [ ] stub catalog が mode-aware になっている
- [ ] README / README.ja / catalog 表記が新 surface と一致している
- [ ] default で見える tool 数が、現行 full surface より明確に縮小されている
- [ ] `desktop_see` / `desktop_touch` を足したときの v2 の見せ方が破綻していない

### Gate B. 足回りの独立価値

- [ ] visual lane の土台が detector 抜きでも独立価値を持つ
- [ ] 画像取得経路が安定している
- [ ] VRAM / dirty rect / capture 周りの責務分離ができている
- [ ] Rust backend の境界が安定している
- [ ] WinOCR ベースの最低限の OCR lane が成立している
- [ ] provider / candidate composition の wiring が main に戻しても説明可能な粒度になっている

### Gate C. Main へ戻しても安全

- [ ] 研究用の重い依存や危険な実験機能を feature flag / env flag で隔離できている
- [ ] `main` に戻す部分だけで build / test / dogfood が成立する
- [ ] ライセンス上 `main` に持ち込みにくいものが分離されている
- [ ] detector 未確定でも stable release の説明ができる
- [ ] rollback 方針がある

### Gate D. 研究テーマの収束

- [ ] この時点以降の主論点が「基盤未整備」ではなく「LLM 選定」へ寄っている
- [ ] detector 比較が branch 側の研究テーマとして自立している
- [ ] `main` に戻したあとも研究ブランチ側で継続実験できる

---

## 4. V2 Main 移行の判断基準

次の条件を満たした時点で、**v2 は `main` へ移行してよい** とみなす。

### 最低条件

- [ ] Gate A 完了
- [ ] Gate B 完了
- [ ] Gate C の major risk が潰れている

### 強い条件

- [ ] v2 の主価値が「60 個近い tools の整理」としてはっきり説明できる
- [ ] detector / 自前モデル / multi-engine OCR が未完でも、`main` に戻す意義が明確
- [ ] 研究 branch の残テーマが、足回りではなく認識性能と LLM 選定に寄っている

---

## 5. 非ブロッカー

以下は **`main` 移行の必須条件ではない**。

- [ ] detector の最終本命が決まっていない
- [ ] OmniParser / Florence-2 / 自前 fine-tune の勝者が未確定
- [ ] multi-engine OCR が未実装
- [ ] DSL serializer が未実装
- [ ] state classifier / relationship inference が未実装
- [ ] Hugging Face 公開や論文化が未着手
- [ ] LLM 選定がまだ研究継続中

言い換えると、これらは **`main` を止める理由ではなく、研究 branch を続ける理由** である。

---

## 6. 実際の移行順

推奨順は次の通り。

1. tool surface 整理を完了する
2. visual / OCR / Rust backend のうち `main` に戻せる土台を分離する
3. WinOCR ベースで stable story を作る
4. `main` に戻す
5. 以降の branch では detector / LLM 選定を研究する

---

## 7. この文書の使い方

運用は単純でよい。

- 実装が進むたびに `[ ]` を `[x]` に flip する
- `main` へ戻すか迷ったら、まず Gate A/B/C を見る
- detector 議論が熱くなったら、`非ブロッカー` を見直す

重要なのは、**研究テーマの未完了** と **`main` へ戻す準備不足** を混同しないこと。

このチェックリストの目的は、その 2 つを明確に分離することである。

