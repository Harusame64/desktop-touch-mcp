# Anti-Fukuwarai v2 Phase 4 指示書

作成: 2026-04-21  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
基準コミット: `3b4ffab fix(vision-gpu): Phase 3 Opus review hardening`

---

## 1. このフェーズの狙い

Phase 1-3 で、`desktop_see` / `desktop_touch` は experimental feature として十分な骨格を持った。  
Phase 4 の役割は、新機能を大きく増やすことではなく、**本当に出せる品質かを判定すること**である。

今回の主題は 3 つ。

1. **experimental quality review**
2. **default-on 判断**
3. **release planning**

ここでは「必ず release する」前提では動かない。  
最終成果は、**出す / まだ出さない** を合理的に決められる状態である。

---

## 2. Phase 3 完了時点の現在地

確認済みの到達点:

- `desktop_see` / `desktop_touch` は server から呼べる
- session isolation, real executor wiring, warnings, semantic diff が揃っている
- browser / terminal / visual lane の provider と ingress がある
- visual lane は replay backend まで接続され、benchmark gate がある
- env flag `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` により experimental 公開済み

まだ残る本番前の論点:

1. experimental surface が既存ツール群より本当に優位か
2. default-on にした時の blast radius は許容できるか
3. release する場合のバージョニング、説明、スモークの手順をどうするか

---

## 3. Phase 4 の判断原則

### 3.1. default-on は「動く」ではなく「後戻りコストが低い」で決める

`desktop_see` / `desktop_touch` が動くことは、default-on の十分条件ではない。  
次を満たして初めて候補になる。

- 既存ツールより誤操作が少ない
- fallback が明確
- failure surface が理解しやすい
- OFF に戻す escape hatch がある

### 3.2. 既存 V1 surface は当面残す

Phase 4 では 58 ツール群を消さない。  
V2 を default-on にしても、V1 は migration path / debug path / escape hatch として残す。

### 3.3. release planning は `docs/release-process.md` に従う

release する場合は、必ず [release-process.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/release-process.md#L1) の順序を守ること。

特に重要:

1. GitHub Release zip が先
2. npm publish は後
3. clean-cache smoke test を必ず通す
4. tag は動かさない

---

## 4. 実装順

Phase 4 は 4 Batch に分ける。

### Batch P4-A - Experimental Quality Review

#### 目的

- V2 facade が本当に LLM UX / 操作成功率 / failure clarity で優位か確認する

#### 実装方針

review 観点を固定して、scenario ベースで検証する。

シナリオ群:

1. browser form 入力
2. browser button click
3. terminal command send
4. terminal prompt 追従
5. native dialog 操作
6. visual-only target 認識
7. stale lease / modal / focus steal の safe fail

各シナリオで比較するもの:

- `desktop_see` / `desktop_touch` のステップ数
- warnings / diff の解釈しやすさ
- fallback の明確さ
- 失敗時の recoverability

成果物:

- review note または checklist
- issue list
- severity 分類

#### 完了条件

- scenario ごとの pass/fail が明文化される
- P0/P1 bug と polish issue が分かれる
- default-on 判断の前提材料が揃う

#### 推奨 commit

```text
docs(facade): add experimental quality review checklist for anti-fukuwarai v2
```

---

### Batch P4-B - Default-on Readiness / Kill Switch

#### 目的

- env flag 付き experimental から default-on 候補へ移るための gate を定義する

#### 実装方針

評価対象:

1. **Activation policy**
   - default-on にするか
   - opt-in のまま据え置くか
   - auto-suggest のみか

2. **Kill switch**
   - env flag で確実に OFF に戻せる
   - default-on 時も legacy tools だけで問題なく動く

3. **Fallback UX**
   - `desktop_see` が warnings を返した時の next action
   - `desktop_touch` fail reason に対する recovery 導線

推奨方針:

- いきなり完全 default-on にはしない
- まずは **experimental ON + docs 推奨 + internal dogfooding** を経て判断する

必要なら env policy を次の 2 段階に分ける。

```text
DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1      # 現行 experimental opt-in
DESKTOP_TOUCH_PREFER_FUKUWARAI_V2=1      # 将来の default-like preference
```

#### 完了条件

- default-on / opt-in 継続 / dogfood 継続の 3 択から判断できる
- kill switch が文書化される
- migration plan が明文化される

#### 推奨 commit

```text
docs(server): define anti-fukuwarai v2 default-on readiness and rollback policy
```

---

### Batch P4-C - Release Planning / Packaging Review

#### 目的

- release する場合に必要な手順と変更点を整理する

#### 実装方針

release 自体はまだやらなくてよい。  
ただし release candidate を切れる状態か確認する。

確認項目:

1. **server surface**
   - env flag ON/OFF の behavior
   - tool descriptions
   - stub-tool catalog / docs 反映要否

2. **versioning**
   - patch / minor / pre-release のどれが妥当か
   - V2 experimental を release note でどう表現するか

3. **packaging**
   - dist に必要ファイルが入るか
   - launcher / zip / HTTP mode が壊れないか

4. **release flow**
   - [release-process.md](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/release-process.md#L1) の Phase 1-7 に乗るか
   - release するなら tag / zip / npm / registry の順が守れるか

推奨 outcome は 2 パターン。

#### Outcome 1: Ship experimental in release notes

- default OFF 維持
- env flag で使えることを documented
- release notes に experimental 明記

#### Outcome 2: Hold release

- まだ risk が高い場合は次 release に持ち越す
- mainline へは載せるが release には含めない判断も可

#### 完了条件

- release する場合としない場合の両方の手順が明文化される
- version bump 方針が決まる
- packaging risk が洗い出される

#### 推奨 commit

```text
docs(release): add anti-fukuwarai v2 release readiness and packaging review
```

---

### Batch P4-D - Ship / No-Ship Decision Memo

#### 目的

- Phase 4 の最終判断を 1 枚にまとめる

#### 実装方針

次のフォーマットで memo を作る。

```text
Decision:
  - Ship experimental in next release
  - Hold and continue dogfooding
  - Blocked by P0 issues

Why:
  - quality review summary
  - benchmark summary
  - rollback confidence

Conditions:
  - env policy
  - docs/update requirements
  - release tasks
```

ここでは願望ではなく、実測と issue list に基づいて決める。

#### 完了条件

- ship/no-ship が一意に読める
- rollback 方法が明記される
- 次アクションが曖昧でない

#### 推奨 commit

```text
docs(facade): record anti-fukuwarai v2 ship decision for next release window
```

---

## 5. 推奨レビュー観点

### 5.1. UX

- `desktop_see` の entity list は過不足ないか
- warnings は noisy すぎないか
- `desktop_touch` の fail reason は行動可能か

### 5.2. Safety

- stale lease の扱い
- modal / focus / viewport check
- visual fallback 時の誤爆リスク

### 5.3. Performance

- idle cost
- warm path latency
- browser/terminal ingress が過剰 refresh しないか

### 5.4. Operational

- env flag policy
- docs のわかりやすさ
- rollback の容易さ

---

## 6. 実装上の制約

### 維持すること

- env flag OFF で現行 behavior を壊さない
- raw coordinates を通常レスポンスに出さない
- release 順序は `release-process.md` に従う

### やらないこと

- このフェーズでいきなり npm publish
- tag 作成
- default-on をコードだけで先に強行
- V1 ツール群の削除

---

## 7. テスト / 検証方針

### P4-A

- scenario checklist
- qualitative review

### P4-B

- env flag ON/OFF
- kill switch
- rollback smoke

### P4-C

- packaging inspection
- HTTP mode smoke readiness
- release process dry-run checklist

### P4-D

- decision memo review

---

## 8. Phase 4 完了の定義

Phase 4 完了時点で次を満たすこと。

1. V2 experimental の品質評価が文書化されている
2. default-on の可否が判断できる
3. rollback / kill switch が整理されている
4. release する場合の手順が `release-process.md` と整合している
5. ship / no-ship が memo として残っている

ここまで来たら、次は実際の release 作業か、dogfooding 継続かを迷わず選べる。
