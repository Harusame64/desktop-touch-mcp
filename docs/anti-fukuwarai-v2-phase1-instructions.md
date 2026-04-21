# Anti-Fukuwarai v2 Phase 1 指示書

作成: 2026-04-21  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
基準コミット: `9f55ec9 feat(facade): add Batch 9 DesktopFacade — desktop_see / desktop_touch (PoC complete)`

---

## 1. この指示書の目的

PoC は完了した。次フェーズでは「動く概念実証」から「混線せず、安全に実運用へ寄せられる実装」へ進める。

本フェーズの主目的は次の 4 つである。

1. **target 単位の session 分離**
2. **executor stub の実配線**
3. **MCP server への実験的公開**
4. **event-first ingress への移行準備**

重要: この順番を崩さないこと。  
`executorFn` を先に本物へ置き換えると、lease / generation の混線を抱えたまま危険な操作経路が増える。

---

## 2. 確認済みのコミット列

PoC は以下の 6 commit で積み上がっている。

1. `f868728 feat(vision-gpu): add Batch 0-3 warm ROI substrate (PoC Phase 0)`
2. `b4c25bd feat(vision-gpu): add Batch 5 Temporal Fusion (PoC Phase 1)`
3. `a4525b9 feat(vision-gpu): add Batch 6 CandidateProducer + harden Batch 3/5 (PoC Phase 1)`
4. `c855946 feat(world-graph): add Batch 7 World Resolver + LeaseStore (PoC Phase 2)`
5. `08acbe3 feat(world-graph): add Batch 8 GuardedTouchLoop (PoC Phase 2)`
6. `9f55ec9 feat(facade): add Batch 9 DesktopFacade — desktop_see / desktop_touch (PoC complete)`

コミット構造は良い。  
`vision-gpu -> world-graph -> facade` の積み上げになっており、次フェーズでもこの分割を維持する。

---

## 3. 現在地の整理

### 3.1. できていること

- `src/engine/vision-gpu/` に warmup / ROI / tracking / fusion / candidate 生成がある
- `src/engine/world-graph/` に resolver / lease-store / guarded-touch がある
- `src/tools/desktop.ts` に facade がある
- unit test は batch ごとに揃っている

### 3.2. まだ PoC のままの箇所

#### A. `DesktopFacade` は single-session

[desktop.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop.ts#L115) は `viewId`, `generation`, `entities`, `lastInput`, `leaseStore` を **1 インスタンス 1 本**で持っている。

この状態だと、複数 target を並行に扱う本番系で次が起きうる。

- window A の `see()` 後に window B を `see()` すると A の lease が全部 stale になる
- per-target generation が分離されない
- post-touch refresh が `lastInput` に引きずられる

#### B. executor が stub

[desktop.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop.ts#L139) は `opts.executorFn ?? (async () => "mouse")` で、まだ実ツールにつながっていない。

#### C. MCP server に未登録

[server-windows.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/server-windows.ts#L140) 以降を見ると、既存ツールは登録されているが `desktop_see` / `desktop_touch` はまだ server に公開されていない。

#### D. Candidate ingress は pull-only

[candidate-producer.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/vision-gpu/candidate-producer.ts#L94) は `ingest(recognitions)` ベースで、`desktop.ts` 側の `CandidateProvider` も sync pull function のままである。  
event-driven invalidation と target-scoped cache はまだない。

---

## 4. 実装順

本フェーズは 4 Batch に分ける。

### Batch A - Per-target session isolation

最優先。ここを最初にやる。

#### 目的

- `hwnd` / `tabId` / `windowTitle` 解決結果ごとに session を分ける
- generation / lease store / entities / lastInput を target scope で閉じる
- target 間の lease bleed を防ぐ

#### 実装方針

新規モジュールを追加する。

```text
src/engine/world-graph/session-registry.ts
```

責務:

- `TargetSessionKey` の生成
- `SessionState` の保持
- session ごとの `LeaseStore`
- session ごとの generation counter
- TTL / eviction

推奨型:

```ts
type TargetSessionKey = `window:${string}` | `tab:${string}` | `title:${string}`;

type SessionState = {
  key: TargetSessionKey;
  viewId: string;
  seq: number;
  generation: string;
  entities: UiEntity[];
  lastInput: DesktopSeeInput;
  leaseStore: LeaseStore;
};
```

`DesktopFacade` は global mutable state を持つのではなく、`SessionRegistry` から current session を解決して使うように変える。

#### 完了条件

- target A / B を交互に `see()` しても session が混線しない
- A の lease が B の `see()` で無効化されない
- generation mismatch は target scope でのみ発生する
- unit test を追加する

#### 推奨 commit

```text
feat(world-graph): add target-scoped session registry for desktop facade
```

---

### Batch B - Real executor wiring

session 分離の次にやる。

#### 目的

- stub executor を既存 handler 群に接続する
- affordance / source に応じた実行経路を本物へ置き換える
- `GuardedTouchLoop` の safe fail を維持する

#### 実装方針

新規モジュール推奨:

```text
src/tools/desktop-executor.ts
```

ここで `UiEntity` から既存 handler への routing を行う。

優先順:

1. UIA evidence -> `clickElementHandler` / `setElementValueHandler`
2. CDP evidence -> `browserClickElementHandler` / `browserFillInputHandler`
3. terminal entity -> `terminalSendHandler`
4. visual-only -> `mouseClickHandler`

既存 handler:

- [clickElementHandler](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/ui-elements.ts#L90)
- [setElementValueHandler](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/ui-elements.ts#L163)
- [browserClickElementHandler](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/browser.ts#L662)
- [browserFillInputHandler](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/browser.ts#L354)
- [terminalSendHandler](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/terminal.ts#L292)
- [mouseClickHandler](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/mouse.ts#L332)

注意:

- facade 層で tool result 全体を露出しない
- `desktop_touch` の戻り値は semantic diff 中心のまま維持する
- raw coordinates は debug 以外で返さない
- visual-only fallback でも guard を外さない

#### 完了条件

- UIA / CDP / terminal / visual-only の 4 route が通る
- stub executor が消える
- stale lease / modal / viewport out で safe fail する
- minimal e2e or integration test を追加する

#### 推奨 commit

```text
feat(facade): wire desktop touch executors to existing tool handlers
```

---

### Batch C - MCP server への experimental 公開

executor が配線できたら行う。

#### 目的

- `desktop_see` / `desktop_touch` を実験フラグ付きで公開する
- PoC モジュールをテスト専用ではなく server path に載せる

#### 実装方針

新規モジュール推奨:

```text
src/tools/desktop-register.ts
```

内容:

- schema 定義
- handler 定義
- `registerDesktopTools(server)` 実装

`server-windows.ts` への登録は feature flag で守る。

例:

```text
DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1
```

このフラグが無いときは既存ツールセットのみを公開する。

#### 完了条件

- env flag ON で `desktop_see` / `desktop_touch` が見える
- env flag OFF で既存挙動に影響しない
- tool description を最低限追加する

#### 推奨 commit

```text
feat(server): register desktop_see and desktop_touch behind experimental flag
```

---

### Batch D - Event-first ingress

最後にやる。これは correctness より efficiency の改善に近い。

#### 目的

- CandidateProvider を pull-only から卒業させる
- dirty-rect / WinEvent / CDP event で target-scoped refresh を起こす
- idle 時の不要 refresh を減らす

#### 実装方針

新規インターフェース推奨:

```ts
type CandidateIngress = {
  getSnapshot(target: DesktopSeeInput["target"]): UiEntityCandidate[];
  invalidate(targetKey: string, reason: "winevent" | "cdp" | "dirty-rect"): void;
  subscribe(targetKey: string, cb: () => void): () => void;
};
```

使う土台:

- `src/engine/winevent-source.ts`
- `src/engine/event-bus.ts`
- browser 側 event stream

この batch では **完全な Desktop Duplication 実装まで踏み込まなくてよい**。  
まずは event-driven invalidation と target-scoped refresh policy を入れる。

#### 完了条件

- idle で periodic full refresh が常態化しない
- target に関係ない event で refresh しない
- recovery path が残る
- benchmark で idle cost の改善が見える

#### 推奨 commit

```text
feat(ingress): make desktop facade candidate refresh event-driven
```

---

## 5. 実装上の制約

### 維持すること

- `desktop_see` は通常レスポンスで raw rect を返さない
- `desktop_touch` は semantic diff を主に返す
- facade 自体は薄く保つ
- hot path の視覚推論詳細は facade に漏らさない

### やらないこと

- いきなり full event bus 書き換え
- Desktop Duplication 本実装の全面着手
- VLM sidecar 統合
- 58 ツールの削除
- release / publish 関連作業

---

## 6. テスト方針

Batch ごとにテストを増やす。

### Batch A

- 2 target 並行 session
- lease bleed 防止
- generation scope

### Batch B

- source/evidence ごとの route 選択
- handler 呼び出し引数の妥当性
- safe fail

### Batch C

- env flag ON/OFF
- MCP tool registration

### Batch D

- event -> invalidate -> refresh の流れ
- unrelated target event の無視
- idle path で refresh しないこと

---

## 7. 最終到達点

Phase 1 完了時点で次を満たすこと。

1. `desktop_see` / `desktop_touch` が server から呼べる
2. session は target scope で分離される
3. `desktop_touch` は本物の executor を呼ぶ
4. idle 時の refresh が抑制される
5. facade の通常レスポンスは raw coordinates を含まない

この段階まで来れば、その先は GPU visual lane の本格 native 化や event source の高度化へ安心して進められる。
