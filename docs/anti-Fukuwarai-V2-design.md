
LLM に画面を見せて座標を選ばせるのではなく、MCP 側がこういうことを引き受けるべきです。

```text
ユーザー意図
  -> LLM の操作意図
  -> desktop_see が操作可能な世界を投影
  -> LLM は entity / affordance を選ぶ
  -> desktop_touch が Action Compiler で安全な実行計画へ変換
  -> 実行後に World Graph と Timeline を更新
```

つまり V2 の本質は「2ツール化」ではなく、**座標操作を typed affordance 操作に変換する OS 的な層**です。

**なぜここまで必要か**
最近の GUI agent 研究を見ると、弱点は一貫しています。

- ScreenSpot-Pro / UI-I2E 系は、高解像度デスクトップではターゲットが小さく、既存 grounding がかなり苦しいことを示しています。
- OmniParser / ScreenAI は、画面パースや UI element annotation が重要だと示していますが、それだけでは「安全に操作する」層にはなりません。
- WorldGUI は、初期状態の揺れだけで planning が壊れる問題を突いています。
- OSWorld-Human は、agent が人間よりステップ数もレイテンシも大きくなりがちな問題を指摘しています。
- UIA / CDP は、使える場面では座標より強い native affordance を持っています。

なので最高形は、**VLM-only でも UIA-only でも OCR-only でもない**。  
複数センサーを「証拠」として束ね、操作直前に再解決し、最短かつ安全な action route を選ぶ層です。

**理想アーキテクチャ**
中核はこの5層です。

```text
1. Facade
   desktop_see / desktop_touch

2. Intent & Action Compiler
   entityId + verb + payload を、UIA/CDP/terminal/mouse fallback の実行計画へ変換

3. UI World Graph
   entity, relation, affordance, evidence, confidence, generation, timeline を保持

4. Active Perception Planner
   何を見るべきか、どのセンサーを使うべきか、どこまで高コスト探索するかを決める

5. Sensor Producers
   Win32, UIA, CDP DOM/AX, OCR/SoM, terminal buffer, raster parser, optional VLM sidecar
```

ここで最重要なのは `UiEntity` ではなく **`Affordance`** です。  
「Save ボタン」は座標ではなく、こういう操作可能性の束として表現します。

```ts
type UiAffordance = {
  verb: "invoke" | "click" | "type" | "select" | "scrollTo" | "submit" | "drag";
  executors: Array<"uia" | "cdp" | "terminal" | "mouse">;
  preconditions: string[];
  postconditions: string[];
  confidence: number;
};
```

`desktop_touch` は entity に触るのではなく、厳密には entity の affordance を実行します。これが Anti-Fukuwarai の核心です。

**Entity Lease**
`desktop_see` が返す ID は永久 ID ではなく、**lease 付き handle** にします。

```ts
type EntityLease = {
  entityId: string;
  viewId: string;
  targetGeneration: string;
  expiresAtMs: number;
  evidenceDigest: string;
};
```

`desktop_touch` は必ず実行前に lease を再検証します。

```text
entityId を受け取る
  -> target identity が同じか確認
  -> entity が同じ意味で再解決できるか確認
  -> offscreen なら scroll
  -> modal / occlusion / stale rect を確認
  -> 最良 executor を選択
  -> 実行
  -> postcondition を検証
```

これで「座標を隠しただけの福笑い」を避けられます。

**PoCのストーリー**
妥協なしの理想から切るなら、PoC の主張はこれです。

```text
座標を一切LLMに選ばせず、
desktop_see が返した entityId だけで、
Chrome と Terminal の操作を安全に完了できる。
```

最初の PoC 名は **Entity Handle Loop** が良いと思います。

```text
desktop_see
  -> entityId を返す

desktop_touch(entityId)
  -> entity を再解決
  -> 最適 route で触る
  -> semantic diff を返す
```

**PoC-1: World Schema**
まずファイルとしては最小でよいです。

- `src/engine/world-graph/types.ts`
- `src/engine/world-graph/producers/uia.ts`
- `src/engine/world-graph/producers/ocr-som.ts`
- `src/engine/world-graph/resolver.ts`
- `src/tools/desktop.ts`

既存資産はかなり使えます。特に [ocr-bridge.ts](D:/git/desktop-touch-mcp/src/engine/ocr-bridge.ts)、[uia-bridge.ts](D:/git/desktop-touch-mcp/src/engine/uia-bridge.ts)、[action-target.ts](D:/git/desktop-touch-mcp/src/engine/perception/action-target.ts)、[target-timeline.ts](D:/git/desktop-touch-mcp/src/engine/perception/target-timeline.ts) は、そのまま土台になります。

**PoC-2: `desktop_see`**
対象は active window または `windowTitle` 指定に限定します。全デスクトップはまだやらない。

返すのは full graph ではなく `ActionView` だけ。

```json
{
  "viewId": "view-1",
  "target": { "title": "..." },
  "entities": [
    {
      "id": "e1",
      "role": "textbox",
      "label": "Search",
      "primaryAction": "type",
      "confidence": 0.96,
      "sources": ["cdp", "ocr"]
    }
  ]
}
```

座標は debug mode 以外では返さない。これが思想として大事です。

**PoC-3: `desktop_touch`**
最初の executor は4種類で十分です。

```text
UIA evidenceあり       -> click_element / set_element_value
CDP evidenceあり       -> browser_click_element / browser_fill_input
terminalPrompt entity  -> terminal_send
OCR/SoM only           -> guarded mouse_click fallback
```

実行結果は `ok` だけでなく、必ず semantic diff を返します。

```json
{
  "ok": true,
  "entity": "e1",
  "executor": "uia",
  "diff": ["value_changed"],
  "next": "continue"
}
```

**PoC-4: Active Perception**
ここで初めて `query` を入れます。

```ts
desktop_see({ query: "passwordを変更できる場所" })
```

これは全画面を雑にVLMへ投げるのではなく、段階探索にします。

```text
structured source search
  -> label / role / actionability match
  -> ambiguous なら ROI crop
  -> OCR/SoM
  -> 必要な時だけ optional VLM sidecar
```

ScreenSpot-Pro 系の教訓から、最初から全画面 grounding しない。**探索範囲を狭めること自体を設計に入れる**のが強いです。

**最初の成功条件**
PoC はこの条件を満たせば勝ちです。

```text
1. desktop_see が Chrome と Terminal で entity list を返す
2. LLM-visible response に raw click coordinates を出さない
3. desktop_touch(entityId) が UIA/CDP/terminal/mouse fallback を選べる
4. touch 前に target generation / stale / modal を検証する
5. 失敗時は誤クリックせず block し、refresh next step を返す
6. 操作後に entity_value_changed / entity_moved / modal_appeared などを返す
```

**やらないこと**
PoC でやらないほうがいいものも明確です。

```text
全画面の完全 World Graph
Component Tree / Max-tree の本実装
VLM sidecar 必須化
58ツールの非公開化
永続DB
複雑な planning engine
```

これらは魅力的ですが、最初の証明には不要です。  
最初に証明すべきなのは **「entity handle で安全に触れる」** ことです。

**参考**
- [OmniParser](https://www.microsoft.com/en-us/research/publication/omniparser-for-pure-vision-based-gui-agent/)
- [ScreenAI](https://research.google/pubs/screenai-a-vision-language-model-for-ui-and-infographics-understanding/)
- [ScreenSpot-Pro](https://huggingface.co/papers/2504.07981)
- [Phi-Ground](https://www.microsoft.com/en-us/research/publication/phi-ground-tech-report-advancing-perception-in-gui-grounding/)
- [WorldGUI](https://huggingface.co/papers/2502.08047)
- [OSWorld](https://proceedings.neurips.cc/paper_files/paper/2024/hash/5d413e48f84dc61244b6be550f1cd8f5-Abstract-Datasets_and_Benchmarks_Track.html)
- [Microsoft UI Automation Control Patterns](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview)
