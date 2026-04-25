# Preprint Draft — RPG / Lease / Guard (Japanese)

作成: 2026-04-25

この文書は、`Reactive Perception Graph` を中核にした preprint / 技術報告の
日本語ドラフトである。目的は、実験結果をまだ埋める前の段階で、
「どのような論文として見せるか」を先に固定することにある。

---

## 0. 一行主張

```text
不確実な外界で動作する LLM agent は、世界状態を暫定的信念として扱い、
外界エンティティへの信頼を lease として束縛し、古くなった仮定に対して
action を guard すべきである。
```

---

## 1. タイトル候補

### Candidate A

**Provisional State, Leased Trust, and Guarded Action: A Substrate for LLM Agents in Uncertain External Environments**

### Candidate B

**Beyond Snapshot-and-Act: Reactive Perception for Safe LLM Agents in Dynamic Interfaces**

### Candidate C

**Reactive Perception Graph for Guarded Action under Stale External State**

---

## 2. 論文の見え方

### この論文が何であるか

- GUI agent の便利機能紹介ではない
- Windows 専用ツールの宣伝でもない
- `desktop-touch-mcp` を具体例にしながら、**不確実な外界で動く LLM agent の一般原理** を述べる論文である

### この論文が何ではないか

- GUI grounding の SOTA を競う論文ではない
- 新しい VLM や ML model を提案する論文ではない
- 多数のツールを並べたカタログ論文ではない

### 中核主張

- 外界状態は `persistent truth` ではなく **provisional belief** として扱うべき
- 行動は単なる delayed action ではなく **guarded execution** であるべき
- 外界エンティティへの信頼は **lease-based trust** として扱うべき
- 高コスト観測は **demand-driven** に行うべき

---

## 3. 和文要旨ドラフト

既存の LLM agent は、外界を一度観測し、その結果を内部文脈に保持したまま後続行動を
行う snapshot-and-act 型ループに依存しがちである。しかし実環境では、フォーカス遷移、
ウィンドウ移動、モーダル出現、エンティティの失効により、観測と行動の間で世界状態が
容易に変化する。本稿は、外界状態を持続的真実としてではなく暫定的信念として扱うべき
であるという立場をとる。この立場に基づき、reactive perception、lease-based trust、
guarded action execution から成る基盤を提案する。提案方式は、暫定的な世界状態を
明示的に維持し、古くなった仮定に対して行動前検証を行い、外界エンティティを失効可能
な lease として束縛する。これを desktop-touch-mcp 上に実装し、不確実な外界をもつ
LLM agent のための安全で観測効率の高い substrate として位置づける。

---

## 4. Introduction 全文ドラフト

大規模言語モデル（LLM）エージェントは、純粋に記号的な入出力だけでなく、デスクトップ
アプリケーション、ブラウザ、ターミナル、その他の人間向けインタフェースを操作すること
が期待されるようになっている。しかしこのような外界は、モデルの外側に状態を持ち、
部分的にしか観測できず、しかもエージェントの都合とは無関係に変化する。エージェントは
不変な入力に対して行動するのではなく、思考中にも変化しうる世界に対して行動している。

それにもかかわらず、多くの既存実装は依然として snapshot-and-act 型のループに依存して
いる。すなわち、エージェントは一度観測し、その結果を文脈内に保持したまま推論し、後続
の行動を「その観測がまだ有効である」ことを暗黙に仮定して実行する。この前提は脆弱で
ある。推論中にフォアグラウンドウィンドウが変化することもあれば、モーダルが出現する
こともあり、スクロールにより対象が可視範囲外へ移動することもある。また、一見同一に
見える外界エンティティが別物に置き換わっていることもある。結果として生じる問題は
単なるタスク成功率の低下ではない。より本質的には、観測と信頼が未分離のまま扱われて
いる点にある。すなわち、一度見たものを、そのまま安全に操作可能なものとして扱って
しまっている。

本稿は、この契約自体を見直すべきだと主張する。外界状態は持続的真実ではなく、
暫定的信念として扱われるべきである。ある観測は、別の観測で上書きされるまでの真実
ではなく、証拠に裏付けられた時間制約付きの belief であるべきだ。同様に、外界
エンティティへの信頼も暗黙かつ永続であってはならない。信頼は明示され、lease として
期間制限され、必要に応じて失効できなければならない。さらに、行動は「モデルがそう
決めたから」という理由だけで実行されるべきではない。安全性に関わる前提がなお成立して
いると確認できた場合にのみ実行されるべきである。

この立場に基づき、本稿では三つの機構から成る substrate を提示する。第一に、どの状態が
まだ新鮮で、どの状態が dirty で、どの状態を demand-driven に再取得すべきかを管理する
reactive perception layer により、暫定的な世界状態を明示的に維持する。第二に、外界
エンティティを unlimited trust ではなく bounded validity を持つ lease として束縛する。
第三に、identity の安定性、フォーカスの正しさ、座標の妥当性、blocking overlay の有無
といった safety-critical な前提を action 実行直前に検証することで、古くなった仮定に
対する guarded execution を実現する。

本稿ではこれらの考えをデスクトップ操作系の上で具体化するが、主張はデスクトップに
限定されない。ブラウザエージェント、workflow agent、その他の外界操作型 LLM system も、
部分的で時間劣化し、外部から変化しうる world model の上で行動するという同じ構造的問題
を抱えている。本稿の貢献は、GUI ツール群の紹介ではなく、不確実な外界に対して LLM agent
が信頼性高く行動するための設計原理を定式化し、その具体的 substrate を示す点にある。

要点は単純である。外界で安全に行動できる LLM agent を作るには、高精度な知覚モデル
だけでは足りない。暫定状態、期限付き信頼、guarded execution を支える明示的な契約が
必要である。

### 貢献の見せ方

1. unreliable external action を observation / validity / execution の契約問題として定式化する
2. provisional state, lease-based trust, guarded action から成る substrate を提案する
3. その substrate を desktop interaction system 上で具体化し、評価可能な形へ落とす

---

## 5. Problem Setting

本稿が対象とするのは、記号的な内部状態へ直接アクセスするのではなく、観測インタフェース
と行動インタフェースを介して外界と相互作用する LLM agent である。このとき、行動に
必要な状態はモデルの外側に存在し、部分的にしか観測できず、しかも観測から次の行動までの
あいだにエージェントの意思とは無関係に変化しうる。この状況は、デスクトップ GUI、
ブラウザ操作、ターミナル作業、その他の human-facing environment に広く現れる。ここで
エージェントは、正解となる状態遷移関数を自ら所有していない。

この設定には四つの本質的性質がある。第一に、観測は部分的である。エージェントが見ている
のは、スクリーンショット、accessibility tree、DOM、OCR、その他の制約付きインタフェース
を通した world の射影にすぎない。第二に、観測は時間劣化する。たとえ観測時点で正しくても、
次の action 実行までに stale になりうる。第三に、行動は危険である。クリック、キーボード
入力、その他の外界 interaction はしばしば不可逆であり、巻き戻しコストを伴う。第四に、
知覚コストは非対称である。ある状態は cheap に再取得できるが、別の状態は高解像度視覚取得
や深い interface traversal のような expensive perception を要する。

この条件下では、素朴な snapshot-and-act ループは不安定になる。ある観測を得たあと、
その観測が次の action にまだ十分有効か、対象 entity への trust が維持されているか、
state refresh のコストを払うべきかを判断しなければならない。しかし既存実装では、これらの
判断は prompt や tool description、あるいは場当たり的な確認ステップの中に暗黙に埋め込まれ
がちである。本稿は、これを明示的な systems contract として扱うべきだと考える。

本稿では、繰り返し現れる失敗モードとして次の五つに注目する。

1. observation-to-action delay
2. focus theft
3. modal insertion
4. entity drift / replacement
5. coordinate / viewport drift

本稿の目的は、知覚一般を解くことでも、より高精度な grounding model を提案することでも
ない。外界状態を provisional に扱い、trust を明示的に束縛し、無効な仮定の上で action を
実行しないための substrate を定義することである。

---

## 6. Design Principles

**P1. External state is provisional.**  
観測結果は durable truth ではなく bounded validity を持つ belief として表現されるべきで
ある。したがって system は value そのものだけでなく、その freshness、evidence、
invalidaton status を追跡しなければならない。

**P2. Trust in external entities is leased.**  
ある時点で actionable だった object を、その後も永続的に actionable とみなしては
ならない。system は entity への trust を、expire, mismatch, revoke 可能な lease として
束縛すべきである。

**P3. Actions are guarded, not merely decided.**  
LLM が選んだ action は、実行命令ではなく proposal にすぎない。実行前には、その action が
依存している仮定がまだ成立しているかを system が検証しなければならない。成立していない
場合に正しい挙動は blind execution ではなく、block、refresh、recover のいずれかである。

**P4. Expensive perception is demand-driven.**  
観測コストは非対称であるため、system はすべての action 後に world 全体を eager refresh
すべきではない。cheap state を先に更新し、uncertainty が本当に重要な時だけ expensive
sensing を起動し、その uncertainty 自体を agent に明示的に返すべきである。

これらの原理をまとめると、本稿の核心は observation, trust, execution の分離にある。
多くの既存 agent loop では、これらが context 内の暗黙状態として一体化している。これに
対し本稿の立場は、それらを LLM と外界の間の異なる層の contract として扱う点にある。

---

## 7. System セクション草案

### 7.1 セクション導入

提案 contract は四つの層からなる。すなわち、暫定状態を維持する reactive perception layer、
外界 entity への一時的 trust を束縛する lease layer、action 前提条件を検証する guarded
execution layer、そして expensive refresh を抑制する observation reduction layer である。

### 7.2 Reactive Perception as Provisional State Maintenance

system は target identity、foreground、geometry、modal blocking、browser readiness、
focused element など task-relevant な property を evidence 付き fluent として保持する。
fluent は observed, dirty, settling, stale, contradicted, invalidated などの状態を取り、
単なる recent observation cache ではなく、「いまも trust してよいか」を表現する belief
store として機能する。

### 7.3 Lease-Based Entity Trust

system は raw coordinate reference を durable commitment として expose しない。代わりに
external entity を lease として束縛する。lease は entity identity、current view generation、
expiration time、evidence digest を持つ temporary handle であり、trust を bounded かつ
revocable にする。

### 7.4 Guarded Action Execution

LLM が選んだ action は immediate command ではなく proposal として扱われる。実行前に
system は、target identity、focus / viewport、blocking overlay、coordinate / geometry
validity などを検証する。これらが崩れていれば blind execution はせず、block, refresh,
recover のいずれかへ遷移する。

### 7.5 Demand-Driven Observation Reduction

cheap state は guard を支えるのに十分な頻度で維持し、より expensive な state は
uncertainty resolution に必要な時だけ refresh する。differential observation は、この
staged refresh を実装可能にする operational path である。

---

## 8. Implementation セクション草案

提案 substrate は `desktop-touch-mcp` 上に実装される。これは MCP interface を通じて desktop
observation と control primitive を提供する Windows 指向の LLM interaction system である。
実装は Win32 metadata, UI Automation, browser-side state, OCR-derived observation,
image-based differential capture を組み合わせている。

### 概念と実装の対応

- perception substrate
  - `src/engine/perception/`
- entity observation and lease issuance
  - `src/tools/desktop.ts`
  - `src/engine/world-graph/lease-store.ts`
- guarded execution and semantic diff
  - `src/engine/world-graph/guarded-touch.ts`
- differential observation
  - `src/engine/layer-buffer.ts`

### 実装の要点

- `Reactive Perception Graph` は fluents, evidence, confidence, freshness を維持する
- `desktop_see` は generation, expiration, digest を持つ lease を発行する
- `desktop_touch` は live snapshot に対して lease と precondition を再検証してから action する
- `layer-buffer` は differential refresh と selective observation を支える

現在の backend は Windows desktop に grounded しているが、提案 contract 自体は backend-agnostic
であるという立場を取る。

---

## 9. Evaluation skeleton

### 評価の問い

**Q1. Safety**  
提案 substrate は、dynamic world change 下で unsafe / invalid external action を減らすか。

**Q2. Observation efficiency**  
提案 substrate は、snapshot-and-act baseline に比べて unnecessary re-observation や
token-heavy confirmation を減らすか。

**Q3. Bounded trust and recovery**  
agent の仮定が invalidated されたとき、naive action loop より structured で recoverable な
失敗を実現するか。

### ベースライン

**Baseline A: Snapshot-and-Act**

- 一度 observe する
- state は model context の中に暗黙保持する
- explicit lease validation なしで後続 action を実行する

**Proposed: RPG + Lease + Guard**

- provisional state を明示的に維持する
- trusted entity を lease で束縛する
- action time に precondition を validate する
- staged, demand-driven に state refresh する

### タスク族

1. focus-sensitive input
2. modal-sensitive interaction
3. entity-validity interaction
4. geometry-sensitive interaction
5. post-action confirmation

### 動的 perturbation

- `focus theft`
- `modal insertion`
- `window move / resize`
- `entity replacement`
- `stale observation delay`

### 主指標

- unsafe action rate
- invalid action attempt rate
- blocked-before-harm rate
- re-observation count per task
- token-heavy observation count per task
- expensive perception escalation count
- task success rate
- mean recovery steps

### 表 skeleton

#### Table 1. Main comparison

| Method | Unsafe action rate | Task success rate | Re-observation count | Token-heavy observations | Recovery steps |
|---|---:|---:|---:|---:|---:|
| Snapshot-and-Act | [ ] | [ ] | [ ] | [ ] | [ ] |
| Proposed | [ ] | [ ] | [ ] | [ ] | [ ] |

#### Table 2. Perturbation breakdown

| Scenario | Snapshot-and-Act unsafe rate | Proposed unsafe rate | Snapshot-and-Act success | Proposed success |
|---|---:|---:|---:|---:|
| Focus theft | [ ] | [ ] | [ ] | [ ] |
| Modal insertion | [ ] | [ ] | [ ] | [ ] |
| Window drift | [ ] | [ ] | [ ] | [ ] |
| Entity replacement | [ ] | [ ] | [ ] | [ ] |
| Delayed action | [ ] | [ ] | [ ] | [ ] |

### ケーススタディ

- Focus theft
- Entity replacement

### 限界の書き方

この評価は、すべての external-world agent に対する完全 benchmark ではなく、提案 contract の
初期 validation として位置づけるべきである。
