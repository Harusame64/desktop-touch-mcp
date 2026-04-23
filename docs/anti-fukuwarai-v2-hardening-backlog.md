# Anti-Fukuwarai v2 — Dogfood Hardening Backlog

作成: 2026-04-23  
対象: `desktop-touch-mcp-fukuwaraiv2` dogfood 後の post-Go hardening  
入力: [`dogfood-incident-report.md`](dogfood-incident-report.md), [`anti-fukuwarai-v2-dogfood-log.md`](anti-fukuwarai-v2-dogfood-log.md)

---

## 1. 要約

dogfood では 25 件の障害・違和感が記録されたが、独立した問題としては 7 件前後に圧縮できる。  
そのうち設計的に大きいのは次の 3 本である。

1. **Lease TTL が LLM 処理時間を前提にしていない**
2. **window / modal / owner の階層を flat に扱っている**
3. **provider capability の negative space がレスポンスに出ていない**

補助的な論点として次がある。

4. **visual lane の昇格条件が保守的すぎる**
5. **windowTitle 曖昧一致で terminal / dialog を取り違える**
6. **日本語 windowTitle の JSON / encoding バグ**
7. **アプリ固有ラベル（例: GitHub body = `"on"`）への query 耐性不足**

---

## 2. 優先度の見方

### 2.1. 件数ベースの重さ

| 根本原因 | 主なカテゴリ | 件数感 |
|---|---|---|
| **R2. Flat window model** | modal / Save As / V1 resolver / keyboard misfocus | 最大 |
| **R1. Lease TTL** | `lease_expired` | 中 |
| **R3. Negative capability 不可視** | `executor_failed` / entity zero | 中 |

### 2.2. 次バッチの ROI

| 優先 | 項目 | 理由 |
|---|---|---|
| **P1** | H1. Lease / TTL hardening | browser-form / terminal の成功率に直結。実装も比較的閉じる |
| **P1** | H4. Visual escalation | PWA / Electron の fallback 依存を減らせる |
| **P2** | H2. Negative capability surfacing | LLM の無駄試行を減らし、reason / warning の意味を強化できる |
| **P2** | H3. Window hierarchy / common dialog | 痛いがスコープが大きい。専用 backlog として扱う |
| **P3** | H5-H7 | 個別バグ・吸収戦略 |

**結論:**  
件数の多さだけなら R2 が最大だが、**次バッチの実装順は H1 -> H4 -> H2 -> H3** が現実的。

---

## 3. Hardening Items

## H1. Lease / TTL hardening

### 症状

- `desktop_see -> desktop_touch` の間で `lease_expired`
- 大きい `explore` 応答（例: 50 entities）で失効しやすい
- terminal / browser-form のような本命シナリオで再現

### 根本原因

lease TTL が「UI freshness」だけを見ており、LLM の読解・推論・次ツール生成時間を別軸として扱っていない。

### 改善候補

1. **固定 TTL 延長**
   - 最小変更で効く
   - ただし stale lease を長く残しやすい
2. **response-size aware TTL**
   - entity 数 / payload size / `view=explore` で TTL を加算
   - dogfood 事象に最も素直
3. **lease refresh / touch-side grace**
   - TTL 近辺なら evidence digest と generation を再確認して猶予
   - 複雑だが UX はよい
4. **see + touch の往復短縮**
   - protocol / facade redesign に近く、別スコープ

### 推奨

**第 1 段階は `response-size aware TTL`。**  
`explore` / large payload のときのみ TTL を延ばし、`action` view の軽いケースは現状に近いまま保つ。

### 完了条件

- S1 / S3 相当で `lease_expired` の再現率が明確に下がる
- stale lease 拒否の安全性を壊さない

---

## H2. Negative capability surfacing

### 症状

- terminal textbox が見えても type できない
- `desktop_see` が 0 entities を返したとき、LLM が「空画面」と誤解する
- CDP なし / visual 未発動 / UIA blind が notes にしか出ず、選択不能

### 根本原因

entity / view に「できないこと」が載っていない。  
LLM は role や entity count から能力を推定するしかなく、誤推論しやすい。

### 改善候補

1. entity に capability を追加
   - 例: `canClick`, `canType`, `requiresCdp`, `providerBlind`
2. view-level の `constraints` / `unavailableProviders` を返す
3. executor 選択不可理由を structured に返す
   - 例: `type_not_supported_by_terminal_lane`

### 推奨

**view-level constraints + entity-level capability の 2 段構え。**  
全部を entity に載せるより、まずは view に「この target では CDP なし / visual 未発動 / UIA blind」を返す方が実装しやすい。

### 完了条件

- `executor_failed` や entity ゼロ時に、LLM が fallback を選びやすくなる
- docs の warning / fail reason と runtime の意味差が縮まる

---

## H3. Window hierarchy / common dialog

### 症状

- Save As dialog を direct target できない
- 親 hwnd で read できても `modal_blocking` で touch できない
- V1 でも `WindowNotFound` / `ElementNotFound`
- keyboard fallback で誤フォーカス事故が起きる

### 根本原因

MCP 側の window モデルが `windowTitle` / `hwnd` の flat 識別子前提で、owner / modal / dialog 階層を表現していない。

### 改善候補

1. **common dialog 特例 resolver**
   - Save As / Open を owner chain で追う
   - 小さく効く
2. **window resolution を hierarchy-aware にする**
   - active / owner / modal child を優先
   - V1/V2 両方に効く
3. **target spec に `ownerHwnd` / `dialogOf` を導入**
   - 綺麗だがスコープ大

### 推奨

**まずは common dialog 特例 + hierarchy-aware resolver。**  
window model の全面改修は大きいので、最初は Save As 系に集中した方が安全。

### 完了条件

- S4 で `desktop_see` か V1 resolver のどちらかが dialog に安定到達できる
- unguarded keyboard fallback 依存を減らせる

---

## H4. Visual escalation / GPU trigger

### 症状

- Outlook PWA / Electron で `single-giant-pane`
- CDP なしでも visual lane が上がらず、OCR fallback 依存
- `view=debug` でも visual provider が未発動

### 根本原因

visual lane の昇格条件が保守的で、`sparse UIA + no CDP` ケースを十分に救っていない。

### 改善候補

1. `single-giant-pane` を visual 昇格条件に入れる
2. `no cdp + sparse uia` を visual candidate にする
3. `view=debug` に visual forcing を与える
4. visual 未発動時の理由を response に出す

### 推奨

**まずは昇格条件の調整 + 未発動理由の可視化。**  
GPU lane そのものの大改修より、なぜ上がらなかったかを返すほうが先。

### 完了条件

- S5 / PWA 系で OCR fallback 前に visual lane が試される
- `visual_provider_*` が出ない理由も operator に分かる

---

## H5. Window targeting / terminal disambiguation

### 症状

- `windowTitle="terminal"` で別タブ・別 CWD に誤送信
- `wait_until(pattern=$)` が PowerShell で外れる

### 推奨

- terminal targeting を `windowTitle` だけに頼らず、foreground / pid / CWD ヒントで補強
- dogfood 手順書の prompt pattern を PowerShell 用に持つ

**優先度:** P3

---

## H6. Japanese windowTitle encoding bug

### 症状

- `set_element_value(windowTitle="タイトルなし")` で JSON parse error

### 推奨

- サーバー側の error response / arg serialization を UTF-16 境界込みで点検
- 再現用 unit test を先に作る

**優先度:** P2  
**性質:** 明確なバグ修正

---

## H7. App-specific query resilience

### 症状

- GitHub body editor が `"on"` ラベルで query に当たらない

### 推奨

- semantic query fallback（role=textbox + placeholder / nearest label / rich editor heuristic）
- ただしアプリ固有吸収なので、一般化しすぎない

**優先度:** P3

---

## 4. 推奨バッチ構成

## Batch H1

- lease TTL hardening
- 必要なら `desktop_see` payload size に応じた TTL 加算
- regression test: S1/S3 相当

## Batch H2

- visual escalation 条件の見直し
- visual 未発動理由の response 化
- regression test: `single-giant-pane + no CDP`

## Batch H3

- negative capability surfacing
- `executor_failed` / entity zero の説明強化

## Batch H4

- common dialog / window hierarchy 調査
- Save As 専用 hardening

---

## 5. 今回の判断

- **release blocker**: なし
- **post-Go hardening**: 必要
- **次バッチの第一候補**: H1 (Lease / TTL) または H4 (Visual escalation)

browser-form / terminal の再現率を先に上げたいなら **H1**、  
PWA / Electron の default-on 体感を先に上げたいなら **H4** を先にやるのがよい。
