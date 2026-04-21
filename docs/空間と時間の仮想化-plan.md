# desktop-touch-mcp - 空間と時間の仮想化 実装計画

作成: 2026-04-21

## 1. この計画の目的

本計画は、`Anti-Fukuwarai v2` の visual lane を実装するための技術本線を定義する。

今回の最重要 benchmark は次の 1 行に要約される。

```text
3D ゲーム中のボタン文字列を、低負荷かつ再現性高く認識し、lease 付き entity として操作できること。
```

そのため、空間と時間の仮想化を次のように再定義する。

- **空間の仮想化**  
  画面を bbox の集合へ変換することではなく、観測対象を ROI と Entity Candidate に還元すること。
- **時間の仮想化**  
  フレーム差分の検知ではなく、track と entity persistence を保つこと。

---

## 2. 中核仮説

### 仮説 A

steady state では hook / event / dirty rect ベースで十分であり、常時 polling は不要である。

### 仮説 B

3D ゲーム UI は full-frame OCR よりも、`dirty ROI -> track -> best frame recognize` のほうが速くて強い。

### 仮説 C

GPU は常時稼働よりも、**warm resident + event-driven burst** として使うほうが本件に適している。

### 仮説 D

Entity Lease を前提にすれば、visual-only lane でも `desktop_touch` の安全性を維持できる。

---

## 3. 監視アーキテクチャ

### 3.1. 原則

監視は event-first とし、polling は fallback か reconciliation に限定する。

### 3.2. ソース別方針

#### Windows / native UI

- `SetWinEventHook` 系 sidecar
- UIA event
- Win32 snapshot は recovery 用

既存の `winevent-source.ts` を第一歩として、event bus よりも低遅延な raw event lane を整備する。

#### Browser

- CDP DOM / AX / navigation / lifecycle event
- `browser_*` 系は periodic refresh を主役にしない

#### Visual / fullscreen

- Desktop Duplication API
- dirty rect
- move rect

### 3.3. ランタイム状態

```text
Idle
  -> Armed
  -> Engaged
  -> Recover
```

| 状態 | 何をするか | 禁止事項 |
|---|---|---|
| Idle | hook 待ち、cache 維持 | OCR, detector, full capture |
| Armed | target を絞る、GPU を warm に保つ | full-frame inference |
| Engaged | dirty ROI のみ処理 | ROI 外の無差別処理 |
| Recover | 再同期、fallback polling | steady state 化 |

---

## 4. GPU warm pipeline

### 4.1. なぜ warmup が必要か

問題になるのは GPU 呼び出しそのものより、次の 4 点である。

1. model load
2. session / graph compile
3. operator initialize
4. CPU <-> GPU copy

したがって visual lane は cold path と warm path を分けて設計する。

### 4.2. pre-shot warmup

起動後または target attach 後に、1 回だけ軽い dummy inference を流す。

```text
model load
  -> session create
  -> graph compile
  -> persistent buffer allocate
  -> dummy ROI infer
  -> warm resident state
```

これを本計画では **pre-shot warmup** と呼ぶ。

### 4.3. warm path の条件

warm path では次を守る。

- 同じ adapter / queue を共有する
- I/O binding や device-local buffer を優先する
- frame 全体ではなく ROI だけ転送する
- output を即 CPU に戻さない

### 4.4. residency policy

- detector session は常駐
- recognizer session は常駐
- tracker state は CPU 側に保持
- VRAM pressure 時のみ evict を許容

---

## 5. アルゴリズム本線

### 5.1. visual-only lane の主パイプライン

```text
Desktop Duplication
  -> dirty rect / move rect
  -> ROI scheduler
  -> ROI tracker
  -> GPU preprocess
  -> scene-text detector
  -> candidate boxes
  -> best frame selection
  -> recognizer
  -> temporal fusion
  -> UiEntityCandidate
```

### 5.2. ROI scheduler

責務:

- dirty rect を少し膨らませて ROI 化
- 近接 dirty rect を merge
- 短時間に揺れる ROI を debounce
- static ROI を一定時間 freeze

推奨ルール:

- `dirty -> expand(8-24px)`  
- `overlap -> merge`
- `stable for N frames -> recognize`
- `no change -> skip`

### 5.3. ROI tracker

track ごとに次を持つ。

```ts
type VisualTrack = {
  trackId: string;
  roi: Rect;
  age: number;
  lastSeenTsMs: number;
  bestFrameScore: number;
  bestFrameRef?: string;
  lastText?: string;
  state: "new" | "tracking" | "stable" | "lost";
};
```

matching は PoC では軽量でよい。

- IoU
- motion continuity
- OCR text similarity

Hungarian を使ってもよいが、PoC では greedy + threshold でも十分である。

### 5.4. detector / recognizer

PoC の優先順位:

1. **scene-text detector**  
   PP-OCR 系または CRAFT 系
2. **recognizer**  
   ONNX 化しやすい OCR recognizer
3. **fallback**  
   既存 Windows OCR / SoM

重要なのは、毎フレーム full OCR しないこと。

### 5.5. temporal fusion

1 フレームの OCR を真実とみなさない。  
track ごとに best frame と vote を持つ。

例:

- confidence weighted vote
- 文字列が揺れる場合は保留
- 連続 2-3 回一致で stable

返却は `UiEntityCandidate` に落とす。

### 5.6. classical lane

desktop UI 向けには古典手法も残す。

- OCR anchor grouping
- component tree / max-tree
- SoM

これは browser / Win32 custom UI で有効。  
ただし 3D ゲーム benchmark の主役にはしない。

---

## 6. World Graph への入力契約

visual lane の出力は `UiEntityCandidate` に統一する。

```ts
type UiEntityCandidate = {
  source: "uia" | "cdp" | "win32" | "ocr" | "som" | "visual_gpu" | "terminal";
  target: { kind: "window" | "browserTab"; id: string };
  sourceId?: string;
  role?: string;
  label?: string;
  value?: string;
  rect?: Rect;
  actionability: Array<"click" | "invoke" | "type" | "read">;
  confidence: number;
  raw?: unknown;
};
```

Entity Resolver は source ごとの差をここで吸収する。

---

## 7. PoC で実装する safety

visual-only lane でも、touch は必ず guarded path を通す。

### 7.1. lease validation

- generation 一致
- TTL 未超過
- evidenceDigest 一致
- 同 label / role / rect bucket で再解決可能

### 7.2. pre-touch checks

- modal
- occlusion
- viewport
- target identity

### 7.3. postconditions

- target disappeared
- target moved
- modal appeared
- value changed

---

## 8. ベンチマーク設計

### 8.1. ケース

1. **3D game**
   - HUD 上のボタン
   - outline font
   - bloom / motion blur
   - camera move 中と静止中
2. **Chrome**
   - CDP + OCR merge
   - virtualized list
3. **Terminal**
   - text buffer + OCR fallback

### 8.2. 指標

| 指標 | 意味 |
|---|---|
| cold start latency | warmup 前の初回 ROI 認識時間 |
| warm ROI latency | warm path の ROI 認識時間 |
| idle CPU/GPU | steady state の常駐コスト |
| VRAM residency | warm session の居座り量 |
| game frame-time impact | ゲームへの干渉 |
| text recall / precision | 認識性能 |
| touch success rate | 操作成功率 |

### 8.3. gate

PoC は次を満たしたら前進してよい。

1. warm path が cold path より明確に速い
2. idle 時に detector が回っていない
3. full-frame OCR が常用されていない
4. 3D game で button text の再認識ができる
5. lease を通した touch が安全に失敗できる

---

## 9. Sonnet 向け実装順

### Phase 0

- benchmark harness
- fixture 収集
- metrics format 決定

### Phase 1

- warmup manager
- ROI scheduler
- visual track skeleton

### Phase 2

- detector / recognizer binding
- temporal fusion
- `UiEntityCandidate` producer

### Phase 3

- Entity Resolver 接続
- Lease 発行
- guarded touch loop

### Phase 4

- `desktop_see`
- `desktop_touch`
- Chrome / Terminal 統合

---

## 10. 明示的に避けること

- steady state の full-frame inference
- 250ms 単位の無条件 OCR
- raw coordinate を facade の主語にすること
- visual lane を一発 OCR で設計すること
- hardest case を最後に回すこと

---

## 11. 関連ドキュメント

- [Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp/docs/Anti-Fukuwarai-V2.md)
- [gpu-visual-poc-plan.md](D:/git/desktop-touch-mcp/docs/gpu-visual-poc-plan.md)
- [som-performance-roadmap-plan.md](D:/git/desktop-touch-mcp/docs/som-performance-roadmap-plan.md)
