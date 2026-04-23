# Anti-Fukuwarai v2 - UI Operating Layer 設計書

作成: 2026-04-21

## 1. ビジョン

`desktop-touch-mcp` の v2 は、LLM に座標を選ばせるツール群ではなく、Windows UI を意味的に操作できる `UI Operating Layer` を提供する。

目標は 3 つある。

1. **LLM UX の改善**  
   ツールを `desktop_see` / `desktop_touch` に集約し、認知負荷とトークン消費を下げる。
2. **操作成功率の改善**  
   座標ではなく Entity と Affordance を操作単位にし、誤クリックを構造的に減らす。
3. **hardest case への対応**  
   UIA/CDP が効かない 3D ゲームやカスタム描画 UI でも、visual-only lane で認識と操作を成立させる。

本設計のキーワードは次の 5 つである。

- **Entity**
- **Affordance**
- **Lease**
- **Event-first**
- **GPU warm pipeline**

---

## 2. 設計原則

### 2.1. 座標は内部表現であり、公開 API ではない

LLM には raw click coordinates を見せない。  
`desktop_see` は Entity とその操作可能性を返し、`desktop_touch` は Entity Lease を受けて実行計画へ変換する。

### 2.2. Structured-first、Visual-second、Visual-only も成立させる

優先順位は次の通り。

1. UIA / CDP / Win32
2. OCR / SoM / classical raster parsing
3. GPU scene-text lane

ただし 3D ゲームや canvas UI では 3 が主役になる。  
structured lane は常に優先されるが、最難関ケースに対応するため visual-only lane を first-class に扱う。

### 2.3. 監視は polling-first ではなく event-first

steady state の常時ポーリングは採らない。  
通常時は hook / event / dirty rect を待ち、必要な時だけ ROI を昇格させる。

### 2.4. GPU は常時処理装置ではなく warm resident accelerator

GPU visual lane は動画エンコードのように常時回さない。  
モデル、セッション、persistent buffer は warm なまま保持し、dirty ROI が来た時だけ短い burst として使う。

### 2.5. Entity ID は永続真実ではなく lease である

`desktop_see` が返す ID は短期ハンドルであり、`desktop_touch` 前に必ず再解決する。  
これにより「座標を隠しただけの福笑い」を避ける。

---

## 3. 北極星アーキテクチャ

```text
User intent
  -> LLM intent
  -> desktop_see
  -> Entity Lease + Affordance selection
  -> desktop_touch
  -> Action Compiler
  -> Executor (UIA / CDP / terminal / guarded mouse)
  -> Semantic diff
  -> World Graph / Timeline update
```

### Layer 1: Facade

LLM に公開するツールは 2 つだけにする。

- **`desktop_see`**
  - ActionView / ExploreView / DebugView を返す
  - Entity の重複を潰し、今操作すべき対象だけを投影する
- **`desktop_touch`**
  - Lease を再検証する
  - 最適 executor を選ぶ
  - postcondition を確認し、semantic diff を返す

### Layer 2: Action Compiler

Entity と affordance を、実際の実行計画へ落とす。

- `invoke` -> UIA `click_element`
- `type` -> `set_element_value` / `browser_fill_input` / `terminal_send`
- `click` -> CDP / UIA / guarded mouse fallback
- `scrollTo` -> smart scroll + re-resolve

Action Compiler は safety gate でもある。

- stale lease を拒否
- generation mismatch を拒否
- modal / occlusion / out-of-view を確認
- 実行後に semantic diff を検証

### Layer 3: UI World Graph

巨大な DOM ではなく、操作のための世界モデルを保持する。

```ts
type UiEntity = {
  entityId: string;
  role: "button" | "textbox" | "link" | "menuitem" | "label" | "unknown";
  label?: string;
  rect?: Rect;
  confidence: number;
  sources: Array<"uia" | "cdp" | "win32" | "ocr" | "som" | "visual_gpu" | "inferred">;
  affordances: UiAffordance[];
  generation: string;
};

type UiAffordance = {
  verb: "invoke" | "click" | "type" | "select" | "scrollTo" | "read";
  executors: Array<"uia" | "cdp" | "terminal" | "mouse">;
  confidence: number;
  preconditions: string[];
  postconditions: string[];
};

type EntityLease = {
  entityId: string;
  viewId: string;
  targetGeneration: string;
  expiresAtMs: number;
  evidenceDigest: string;
};
```

### Layer 4: Active Perception Planner

planner は「何を見るか」と「どこまで高コスト探索するか」を決める。

- structured source で見つかるなら visual lane を起動しない
- dirty rect が小さいなら ROI 処理だけ行う
- ambiguous な時だけ OCR / scene-text / SoM に昇格する
- full-frame inference は steady state では禁止する

### Layer 5: Sensor Lanes

#### A. Structured lane

- Win32
- UIA
- CDP DOM / AX
- terminal buffer

#### B. Visual classic lane

- Windows OCR
- SoM
- OCR anchor grouping
- component tree / max-tree

#### C. Visual GPU lane

- Desktop Duplication
- dirty rect / move rect
- ROI tracker
- scene-text detector / recognizer
- temporal fusion

---

## 4. 監視と実行のランタイムモデル

steady state のランタイムは次の 4 状態で考える。

### 4.1. Idle

- OCR しない
- full-frame capture しない
- hook と cached state だけ維持する

### 4.2. Armed

- WinEvent / UIA / CDP / dirty rect を待つ
- GPU session は warm のまま保持する
- Entity cache は TTL 管理する

### 4.3. Engaged

- dirty ROI だけ処理
- tracker を更新
- best frame のみ recognizer に送る

### 4.4. Recover

- event drop
- focus steal
- tracker drift
- sidecar restart

この時だけ reconciliation を走らせる。  
polling は recovery path でのみ主役になる。

---

## 5. `desktop_see` / `desktop_touch` の公開仕様

### `desktop_see`

```ts
desktop_see({
  target?: { windowTitle?: string; hwnd?: string; tabId?: string };
  view?: "action" | "explore" | "debug";
  query?: string;
  maxEntities?: number;
  debug?: boolean;
})
```

返却例:

```json
{
  "viewId": "view-42",
  "target": {
    "title": "GameWindow",
    "generation": "gen-123"
  },
  "entities": [
    {
      "entityId": "ent-7",
      "label": "Start Match",
      "role": "button",
      "confidence": 0.91,
      "sources": ["visual_gpu", "ocr"],
      "primaryAction": "invoke"
    }
  ]
}
```

公開レスポンスには、debug mode を除いて raw coords を含めない。

### `desktop_touch`

```ts
desktop_touch({
  lease: EntityLease;
  action?: "auto" | "invoke" | "click" | "type" | "select";
  text?: string;
})
```

返却例:

```json
{
  "ok": true,
  "executor": "mouse",
  "diff": ["entity_disappeared", "modal_appeared"],
  "next": "refresh_view"
}
```

---

## 6. PoC の優先順位

本線の hardest case は 3D ゲームである。  
したがって PoC は facade からではなく、visual-only lane の成立確認から始める。

### PoC-0: Benchmark Harness

ベンチマーク対象:

1. **3D ゲーム**
2. **Chrome**
3. **Terminal**

測るもの:

- cold start latency
- warm ROI latency
- CPU %
- GPU %
- VRAM residency
- game frame-time impact
- text recall / precision
- touch success rate

### PoC-1: Event + GPU Warm Substrate

証明すること:

- WinEvent / CDP / dirty rect で idle 時の負荷を下げられる
- GPU model/session を warm に保てる
- pre-shot warmup で初回遅延を吸収できる

### PoC-2: Game Visual Track

証明すること:

- 3D ゲームの画面上テキストを ROI-first で track できる
- detector と recognizer を毎フレーム回さずに済む
- button-like text を `UiEntityCandidate` に落とせる

### PoC-3: Lease + Touch Loop

証明すること:

- visual-only entity に lease を発行できる
- 再解決して guarded click ができる
- semantic diff まで返せる

### PoC-4: Facade Integration

証明すること:

- `desktop_see` / `desktop_touch` で Chrome / Terminal / 3D game を一つの表面 API で扱える

---

## 7. 成功条件

PoC 成功の最低条件は次の通り。

1. 3D ゲーム中の button text を warm path で再認識できる
2. steady state で full-frame OCR を常用しない
3. idle 時の CPU/GPU 負荷が低い
4. `desktop_see` が raw coordinates なしで操作候補を返せる
5. `desktop_touch` が stale lease を拒否し、誤クリックを避けられる
6. Chrome / Terminal / visual-only UI を同じ world schema で扱える

---

## 8. 非目標

PoC の段階では次をやらない。

- 全デスクトップの完全 world graph 永続化
- 58 ツールの即時削除
- VLM sidecar の必須化
- full-frame 常時 OCR
- 複雑な planning engine

---

## 9. 関連ドキュメント

- [anti-fukuwarai-v2-experimental-quality-review.md](anti-fukuwarai-v2-experimental-quality-review.md) — P4-A review 結果 (pass/partial/issue list)
- [anti-fukuwarai-v2-default-on-readiness.md](anti-fukuwarai-v2-default-on-readiness.md) — P4-B: default-on readiness / rollback policy
- [anti-fukuwarai-v2-default-on-rollout-plan.md](anti-fukuwarai-v2-default-on-rollout-plan.md) — default-on 候補へ進めるための次タスク整理
- [anti-fukuwarai-v2-activation-policy.md](anti-fukuwarai-v2-activation-policy.md) — P4-E Batch A: activation / disable flag / env matrix
- [anti-fukuwarai-v2-coexistence-policy.md](anti-fukuwarai-v2-coexistence-policy.md) — P4-E Batch A: V1/V2 priority order / fallback policy
- [anti-fukuwarai-v2-dogfood-log.md](anti-fukuwarai-v2-dogfood-log.md) — P4-E Batch C: dogfood 実録 / 合格ライン（Tier 2 ユーザー担当）
- [anti-fukuwarai-v2-tier2-dogfood-checklist.md](anti-fukuwarai-v2-tier2-dogfood-checklist.md) — Tier 2 実録を埋めるための簡易チェックリスト
- [anti-fukuwarai-v2-tier2-final-decision-instructions.md](anti-fukuwarai-v2-tier2-final-decision-instructions.md) — Tier 2 実録後の Go / No-Go 最終判定 instructions
- [anti-fukuwarai-v2-batch-c-tier1-review.md](anti-fukuwarai-v2-batch-c-tier1-review.md) — P4-E Batch C: Tier 1 技術的暫定 Go レビュー ✅
- [anti-fukuwarai-v2-v17-final-decision-memo.md](anti-fukuwarai-v2-v17-final-decision-memo.md) — **v0.17.0 default-on 最終判定: Go（release candidate）**
- [anti-fukuwarai-v2-hardening-backlog.md](anti-fukuwarai-v2-hardening-backlog.md) — dogfood 後の post-Go hardening backlog（TTL / visual / hierarchy / capability）
- [anti-fukuwarai-v2-hardening-implementation-instructions.md](anti-fukuwarai-v2-hardening-implementation-instructions.md) — hardening backlog を順次修正で進めるための実装指示書
- [anti-fukuwarai-v2-g1-g2-implementation-instructions.md](anti-fukuwarai-v2-g1-g2-implementation-instructions.md) — G1/G2: production guard / terminal background send 実装指示
- [anti-fukuwarai-v2-phase4c-release-planning-instructions.md](anti-fukuwarai-v2-phase4c-release-planning-instructions.md) — P4-C: release planning / packaging review 指示書
- [anti-fukuwarai-v2-phase4d-decision-memo-instructions.md](anti-fukuwarai-v2-phase4d-decision-memo-instructions.md) — P4-D: ship / no-ship decision memo 指示書
- [anti-fukuwarai-v2-ship-decision-memo.md](anti-fukuwarai-v2-ship-decision-memo.md) — **P4-D 最終判断: Ship experimental in next release (v0.16.0)**
- [空間と時間の仮想化-plan.md](D:/git/desktop-touch-mcp/docs/空間と時間の仮想化-plan.md)
- [gpu-visual-poc-plan.md](D:/git/desktop-touch-mcp/docs/gpu-visual-poc-plan.md)
- [system-overview.md](D:/git/desktop-touch-mcp/docs/system-overview.md)
