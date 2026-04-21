# Anti-Fukuwarai v2 Phase 2 指示書

作成: 2026-04-21  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
基準コミット: `2063e9c fix(ingress): dispose facade on reset + document targetKeyToSpec (Batch D hardening)`

---

## 1. このフェーズの狙い

Phase 1 で、`desktop_see` / `desktop_touch` は server 上で呼べるところまで来た。  
Phase 2 では、Facade の「表面」を変えずに、その中身を **PoC quality から product quality へ** 引き上げる。

今回の主題は次の 4 つ。

1. **source richness** を上げる
2. **source-specific identity** を明示する
3. **semantic diff / warnings** を実用化する
4. **browser / terminal / visual lane の event ingress** を本物にする

ここでは release はまだしない。  
まず experimental surface の信頼性と観測密度を上げる。

---

## 2. Phase 1 完了時点の現在地

### 2.1. 良い状態

- per-target session isolation は入った
- executor stub は real backend に接続された
- `desktop_see` / `desktop_touch` は env flag 付きで登録された
- candidate ingress は event-first cache を持つ

### 2.2. まだ PoC 的な箇所

#### A. provider が UIA 偏重

[desktop-register.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-register.ts#L96) の provider は実質 UIA snapshot だけで、browser / terminal / visual_gpu の source richness がまだ足りない。

#### B. `sourceId` が暗黙契約

[desktop-executor.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-executor.ts#L49) にある通り、`sourceId` は UIA AutomationId と CDP selector と visual trackId を兼ねており、意味が source ごとに異なる。  
このままでも PoC は回るが、本番化では危険。

#### C. warnings が表面にまだ出ていない

[desktop.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop.ts#L37) には `warnings?: string[]` があるが、現状 `see()` 返却では埋めていない。

#### D. event-first ingress は WinEvent 中心

[candidate-ingress.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/candidate-ingress.ts#L149) は WinEvent adapter を持つが、browser / terminal / visual lane の invalidation はまだ薄い。

#### E. UIA provider の `hwnd` ルートが弱い

[desktop-register.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-register.ts#L102) では `target.hwnd` を `windowTitle` の代わりに渡しており、`getUiElements(..., { hwnd })` までは使っていない。  
Phase 2 の早い段階で直すこと。

---

## 3. 実装順

Phase 2 は 5 Batch に分ける。

### Batch P2-A - Source Identity 正規化

#### 目的

- `sourceId` の曖昧さを解消する
- executor routing を暗黙契約ではなく型で表す

#### 実装方針

`UiEntity` か `UiEntityCandidate` に source ごとの locator を持たせる。

推奨例:

```ts
type EntityLocator = {
  uia?: { automationId?: string; name?: string };
  cdp?: { selector?: string; tabId?: string };
  terminal?: { windowTitle?: string };
  visual?: { rect?: Rect; trackId?: string };
};
```

最低限やること:

- `sourceId` への依存を executor から剥がす
- resolver で locator を統合する
- `desktop-executor.ts` は locator ベースで route する

#### 完了条件

- source ごとの locator 意味が明文化される
- `sourceId` の暗黙依存が無くなる
- tests が locator ベースへ更新される

#### 推奨 commit

```text
refactor(world-graph): make entity locators source-aware
```

---

### Batch P2-B - Multi-provider desktop_see

#### 目的

- `desktop_see` に browser / terminal / visual_gpu / UIA の複数ソースを入れる
- source richness を上げる

#### 実装方針

provider を source 別に分割する。

```text
src/tools/desktop-providers/
  uia-provider.ts
  browser-provider.ts
  terminal-provider.ts
  visual-provider.ts
  compose-providers.ts
```

優先順位:

1. browser provider
   - CDP interactive / selector / role / label
   - 必要に応じて OCR fallback
2. terminal provider
   - terminal buffer
   - OCR fallback は補助
3. visual provider
   - candidate-producer 経由
4. uia provider
   - `hwnd` path を正しく使う

`compose-providers.ts` で target に応じて provider を選び、必要なら複数ソースを merge して `UiEntityCandidate[]` を返す。

#### 完了条件

- browser target で CDP source が出る
- terminal target で terminal source が出る
- visual target で visual_gpu source が出る
- UIA provider が `hwnd` 指定を正しく使う

#### 推奨 commit

```text
feat(facade): compose desktop see providers across uia cdp terminal and visual lanes
```

---

### Batch P2-C - Warnings / Partial Result / Degradation Surface

#### 目的

- provider failure や partial result を LLM-visible にする
- silent fallback を減らす

#### 実装方針

`DesktopSeeOutput.warnings` を本当に使う。

例:

- `"uia_provider_failed"`
- `"cdp_unavailable"`
- `"visual_cache_stale"`
- `"partial_results_only"`

戻り値の shape は変えず、warnings だけ追加する。

また `desktop_touch` 側にも必要なら next hint を増やす。

例:

- `refresh_view`
- `retry_after_focus`
- `retry_after_navigation`

#### 完了条件

- provider failure が stderr だけでなく response にも乗る
- partial results が判別できる
- tests が warnings を検証する

#### 推奨 commit

```text
feat(facade): surface provider warnings and partial results in desktop_see
```

---

### Batch P2-D - Semantic diff 強化

#### 目的

- `desktop_touch` の diff を実用レベルへ上げる

#### 実装方針

今は [guarded-touch.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/guarded-touch.ts#L11) の diff が

- `entity_disappeared`
- `entity_moved`
- `modal_appeared`
- `modal_dismissed`

までなので、ここに最低限次を足す。

- `value_changed`
- `entity_appeared`
- `focus_shifted`

`value_changed` は UIA / terminal / browser source で source-specific に取ってよい。  
全 source 一律にやろうとしなくてよい。

#### 完了条件

- type action 後に `value_changed` を返せる
- dialog open / close 以外の変化も取れる
- semantic diff が action review に使える

#### 推奨 commit

```text
feat(world-graph): enrich desktop touch semantic diff with value and focus changes
```

---

### Batch P2-E - Event ingress 拡張

#### 目的

- WinEvent だけでなく browser / terminal / visual lane に invalidation を広げる

#### 実装方針

`CandidateIngress` 自体は変えず、event source を増やす。

候補:

- browser: CDP event source
- terminal: prompt/output mutation signal
- visual: manual invalidation hook または dirty-rect adapter

Phase 2 では full Desktop Duplication 本実装まで行かなくてよい。  
ただし `visual-provider` に対して invalidation hook がある状態にはしたい。

#### 完了条件

- browser target は WinEvent なしでも invalidate される
- terminal target は output 変化で refresh できる
- visual target は manual invalidation 以上を持つ

#### 推奨 commit

```text
feat(ingress): extend candidate invalidation across browser terminal and visual sources
```

---

## 4. 実装上の注意

### 維持すること

- `desktop_see` の通常レスポンスに raw coordinates を出さない
- env flag OFF の blast radius を増やさない
- session isolation を崩さない
- idle cost の低さを維持する

### やらないこと

- release 作業
- desktop v2 を default ON にすること
- full Desktop Duplication の全面実装
- learned model の大規模導入

---

## 5. テスト方針

### P2-A

- locator 統合
- executor route の型安全性

### P2-B

- source 別 provider unit test
- compose provider integration test

### P2-C

- warnings が response に出る
- partial result が区別できる

### P2-D

- `value_changed`
- `entity_appeared`
- `focus_shifted`

### P2-E

- browser invalidation
- terminal invalidation
- visual invalidation hook

---

## 6. Phase 2 完了の定義

Phase 2 完了時点で次を満たすこと。

1. `desktop_see` が UIA 以外の source を普通に返す
2. executor routing が source-aware locator ベースになる
3. provider 障害や partial result が warnings で見える
4. `desktop_touch` diff が action review に耐える
5. event-driven ingress が WinEvent 以外にも広がる

この段階まで来れば、Phase 3 で GPU visual lane の native 化、browser integration の強化、default-on 判断へ進める。
