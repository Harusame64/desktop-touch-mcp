# 福笑い脱却プラン

> 2026-04-13 — Claude Sonnet 4.6 との対話から生まれた実装計画
> 関連: [`anti-fukuwarai-ideals.md`](./anti-fukuwarai-ideals.md)（理想の言語化）

---

## Context

`docs/anti-fukuwarai-ideals.md` は「LLMが操作しながら考えられるMCP」という理想を7項目で言語化した。現状の `desktop-touch-mcp` は座標ベースの操作には強いが、**「操作の前後で世界が意味として言語化されない」**という根本課題を抱える。

具体的な現状（コードベース精査で確定した事実）:

- 32 ツール全てが zod 入力スキーマを持つが、**出力スキーマは `{content:[...]}` の汎用エンベロープのみ**（`src/tools/_types.ts:7-10`）
- `click_element` は `{"ok":true,"element":"<Name>"}` だけを返し、**操作後の状態変化は何も語らない**（`src/engine/uia-bridge.ts:156-203`）
- エラーは全ハンドラで `"<tool> failed: ${err}"` の終端的文字列（例: `src/tools/ui-elements.ts:66`）
- OCR / UIA 結果に **信頼度スコアがゼロ**
- UIA キャッシュ API `updateUiaCache` / `getCachedUia` が `src/engine/layer-buffer.ts:296-307` に実装済みだが**どこからも呼ばれていない**
- 200ms ポーリング処理が `src/tools/browser.ts:664-679` / `src/tools/workspace.ts:204-228` / `src/tools/dock.ts:314-344` の **3 箇所にコピペ**
- MCP レベルの出力形状テストはゼロ → 形状変更は安全

この計画は理想 7 項目を Phase 0〜3 に割り付けて段階的に橋渡しする。Phase 4（意図ベース複合操作 `fill_form` / `navigate_to`）は Phase 3 完了後の実使用で必要性を再評価し、別計画とする。

---

## 根本原則

> **LLM は「何が起きたか」を推測してはならない。MCP の応答は世界の差分である。**

7 つの理想はこの原則の側面:

| 理想 | 原則への寄与 |
|---|---|
| 1 状態の言語化 | 「コミット + diff」を返す |
| 2 why/state | 「コミット成立/失敗の理由」 |
| 3 軽量文脈 | 「world model の安価な再同期」 |
| 4 信頼度 | 「観測の確度」 |
| 5 意図操作 | 「複合コミット」 |
| 6 失敗説明 | 「失敗 + 回復経路」 |
| 7 UIA キャッシュ | 「memo 化された world model」 |

LLM 側が再観測トークンを使わず、内部モデルが正確に保たれ続けることを目指す。

---

## 合意された設計判断

| 決定事項 | 選択 |
|---|---|
| Scope | **Phase 0〜3 全部**（Phase 4 は後日判断） |
| narration の既定 | **全 action 系ツール常時 ON**（opt-in ではなく、~30 トークンの最小 post を必ず返す） |
| 後方互換 | **形状変更自由**。LLM 指示文（`src/index.ts:21-167`）を同時更新して合わせる |
| P0 優先順 | **建設的エラー → UIA キャッシュ活性化 → wait_until + pollUntil** |

---

## Phase 0 — 足場

### 0.1 出力エンベロープ型の導入
**Why**: narration / 構造化エラー / confidence を後で乗せる土台として、出力の型を先に整える。散らかりを防ぐ。
**How**:
- `src/tools/_types.ts` に `ToolSuccess<T>` / `ToolFailure` の discriminated union を追加
- 共通ヘルパー `ok(payload)` / `fail(error)` を同ファイルに置く
- 全ハンドラの `return { content: [{ type:"text", text: JSON.stringify(...) }] }` を一律 `ok(...)` / `fail(...)` 経由に差し替え
- Phase 1 以降の変更点（post, hints, suggest）はすべてこのヘルパー経由に集約

### 0.2 `pollUntil` 共通化
**Why**: 3 箇所のコピペ解消と `wait_until` ツールの基盤確立を同時に片付ける。
**Where**: 新規 `src/engine/poll.ts`、置換対象は `browser.ts:664` / `workspace.ts:204` / `dock.ts:314`
**Shape**:
```ts
pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: { intervalMs: number; timeoutMs: number; onTick?: (elapsed: number) => void }
): Promise<{ ok: true; value: T; elapsedMs: number } | { ok: false; timeout: true; elapsedMs: number }>
```

---

## Phase 1 — P0（最優先・即効性）

### 1.1 建設的エラーラッパー（理想 6）
**Why**: 現状の `"X failed: Error: ..."` には次の一手のヒントがない。失敗から学べる情報を渡す。
**How**:
- `src/tools/_errors.ts` 新設。`ToolError { code, message, suggest?: string[], context?: object }`
- 典型失敗パターンに suggest を仕込む:
  - `WindowNotFound` → `["Run get_windows to see available titles", "Try partial title match"]`
  - `ElementNotFound` → `["Call get_ui_elements for candidate names", "Use screenshot(detail='text') for actionable[]"]`
  - `InvokePatternNotSupported` → `["Use mouse_click with clickAt coords", "Use set_element_value for text inputs"]`
  - `UiaTimeout` → `["Retry with cached=true", "Try screenshot(detail='image') for visual fallback"]`
- 全ハンドラの catch 節を `failWith(err)` に置換 → 自動で ToolError に正規化
- `src/index.ts:175-185` の failsafe ラッパーと連携させる

### 1.2 キャッシュ／ベースラインの age・validity 透明化（理想 2 + 7）
**Why**: 今の `desktop-touch-mcp` には「時間で失効する状態」が 3 種類あるが、**どれも LLM から見えない**。実際に「diffMode の I-frame（baseline）の消失期間が分からなくて不安」という声が出ている。
- `layer-buffer.ts:60` の `LAYER_TTL_MS = 90_000`（diff の baseline、90 秒 TTL）
- `layer-buffer.ts:296-307` の UIA キャッシュ（実装済みだが未配線）
- `window-cache.ts:36` の HWND レイアウトキャッシュ（60 秒 TTL）

さらに `workspace.ts:102` の `workspace_snapshot` が問答無用で `clearLayers()` を呼ぶなど、**無効化イベントも不透明**。現状 `src/index.ts:26` の説明は `"After any action: screenshot(diffMode=true) → only changed windows sent"` の一行のみで TTL も invalidation 条件も書かれていない。

#### 1.2.a UIA キャッシュの活性化
- `src/engine/uia-bridge.ts:275 getUiElements` に `cached?: boolean` オプションを追加
- cached=true のとき `getCachedUia(hwnd)` を先に読み、ヒット時は PowerShell を再起動せず差分返却: `"Changed: display value '0' → '29,232'"`
- `get_ui_elements` / `click_element` / `screenshot(detail='text')` にパラメータ伝播
- 既存の `updateUiaCache` を、成功した UIA 取得のたびに必ず呼ぶように配線

#### 1.2.b 同一性の保持（HWND 再利用 / アプリ再起動対策）
**Why**: 時間だけでなく「同一性」でもキャッシュは壊れる。典型例:
1. LLM が電卓を操作中にユーザが裏で電卓を閉じる → HWND が vanish
2. ユーザが電卓を再起動 → 同じタイトルだが別 HWND / 別 pid
3. LLM は「さっきの電卓」と思って操作を続ける → baseline 不在で混乱、もしくは title 一致だけで別インスタンスを誤操作

**How**:
- キャッシュエントリのキーを `hwnd` から複合キー `{hwnd, pid, processStartTimeMs}` に拡張
  - `pid` / `processStartTimeMs` は Win32 `GetWindowThreadProcessId` + `GetProcessTimes` で取得
- `window-cache.ts:46-49` の invalidation ロジックを拡張:
  - HWND が enum から消えた → `hwnd_vanished`
  - 同 HWND だが pid が変わった → `hwnd_reused`（警告レベル）
  - 同 title / 同 pid だが processStartTimeMs が変わった → `process_restarted`
- title 解決時は「**最新の一致候補**」と「**前回保持していた identity**」を比較し、食い違えば hints で知らせる

#### 1.2.c キャッシュ状態 hints の統一露出
screenshot / get_ui_elements / click_element の応答 `hints` に共通フィールドを追加:
```ts
hints.target: {                          // いま操作している対象の identity
  hwnd: number,
  pid: number,
  processName: string,
  processStartTimeMs: number,
  titleResolved: string                  // 部分一致で解決された実タイトル
},
hints.caches: {
  diffBaseline?: {
    exists: boolean,
    ageMs?: number,
    expiresInMs?: number,
    degradedToFull?: boolean,
    invalidatedBy?: "ttl" | "workspace_snapshot" | "manual_clear"
                  | "hwnd_vanished" | "hwnd_reused" | "process_restarted" | null,
    previousTarget?: { pid: number; processName: string }  // identity が変わったときの旧値
  },
  uiaCache?: { exists: boolean; ageMs?: number; expiresInMs?: number },
  windowLayout?: { ageMs: number; expiresInMs: number }
}
```
→ LLM は「この diff はどの時点の、どのアプリインスタンスからの差分か」を完全に言語化できる。

#### 1.2.d LLM 指示文の更新
`src/index.ts:21-167` に以下を明記:
- diff baseline は **90 秒 TTL**、`workspace_snapshot` 呼び出しで自動クリア
- UIA キャッシュは **90 秒 TTL**
- 各ツール応答の `hints.caches` から現時点の age / 有効期限が取れる
- 不安なときは `hints.caches.diffBaseline.exists === false` を見れば「この応答は full snapshot」と判定可能
- `hints.target` の pid / processStartTimeMs が前回応答と変わっていたら **アプリが再起動** している。前提の操作履歴は無効と考える
- `invalidatedBy: "hwnd_reused"` が出たら HWND 再利用。**直ちに再確認のため get_windows を呼ぶ**

### 1.3 `wait_until` ツール（理想 5a）
**Why**: 現状 LLM は「ページ読み込み完了」「値変化」を待つためにスクリーンショットをループで撮るしかない。`macro.ts:116` にも `sleep` しか待ち系が無い。
**Shape**:
```ts
wait_until({
  condition: "window_appears" | "window_disappears" | "focus_changes" | "value_changes" | "element_appears" | "ready_state",
  target: { windowTitle?: string; elementName?: string; elementSelector?: string },
  timeoutMs?: number,  // default 5000, max 30000
  intervalMs?: number  // default 200
})
→ ok({ elapsedMs, observed: "<何が変わったか>" }) | fail({ code:"WaitTimeout", last:<最後に観測した状態> })
```
- 実装は Phase 0.2 の `pollUntil` の薄いラッパー
- `TOOL_REGISTRY`（`src/tools/macro.ts:35-59`）に登録 → `run_macro` 内でも使える

---

## Phase 1 図解

### 全体像 — Phase 0〜1 のレイヤ構造

```
┌────────────────────────────────────────────────────────────┐
│                        LLM (Claude)                         │
│                                                             │
│   構造化された応答を受け取る：                                │
│   - post（操作後の状態）                                     │
│   - hints（キャッシュ年齢・同一性・失効理由）                  │
│   - suggest（失敗時の次の一手）                              │
└─────────────────────────┬──────────────────────────────────┘
                          ▲
                          │ JSON-RPC
                          │
┌─────────────────────────┴──────────────────────────────────┐
│                   MCP Handler 層                            │
│                                                             │
│   ┌────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│   │  ok/fail   │  │  ToolError   │  │   wait_until     │   │
│   │  エンベロープ │  │  + suggest   │  │   (1.3 で追加)    │   │
│   │   (0.1)    │  │    (1.1)     │  │                  │   │
│   └────────────┘  └──────────────┘  └────────┬─────────┘   │
└──────────────────────────────────────────────┼─────────────┘
                                               │ 使う
┌──────────────────────────────────────────────┴─────────────┐
│                    Engine 層                                │
│                                                             │
│   ┌────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│   │ pollUntil  │  │   layer-buffer   │  │  identity     │  │
│   │   (0.2)    │  │  + cache hints   │  │  tracker      │  │
│   │            │  │  (1.2.a, 1.2.c)  │  │  (1.2.b)      │  │
│   │ 3箇所の    │  │                  │  │ {hwnd, pid,   │  │
│   │ コピペを統合 │  │  TTL + 同一性検査 │  │  startTime}   │  │
│   └────────────┘  └──────────────────┘  └───────────────┘  │
└────────────────────────────┬───────────────────────────────┘
                             │
                             ▼
              Windows UIA  /  CDP  /  Win32 API
```

---

### 1.1 建設的エラー — Before / After

**Before（福笑い）** — 失敗して終わり、次の一手が分からない:

```
  LLM: click_element(windowTitle="電卓", name="保存")
        │
        ▼
  MCP: ❌ "click_element failed: Error: ElementNotFound"
        │
        ▼
  LLM: 「保存ボタンが無い…？ もう一度スクショ撮る？
        別の名前で試す？ そもそもウィンドウが違う？」
        ＼(´・ω・`)／
```

**After（建設的）** — 失敗コミット + 回復経路:

```
  LLM: click_element(windowTitle="電卓", name="保存")
        │
        ▼
  MCP: ❌ {
         code: "ElementNotFound",
         message: "No element named '保存' in 電卓",
         suggest: [
           "Call get_ui_elements for candidate names",
           "Use screenshot(detail='text') for actionable[]",
           "Try partial match (e.g. '保' or '存')"
         ],
         context: { windowTitle: "電卓", attempted: "保存" }
       }
        │
        ▼
  LLM: 「じゃあ get_ui_elements で候補を見る」(・ω・)ノ
```

---

### 1.2 キャッシュ・同一性の可視化

#### タイムライン図 — 時間による失効（TTL）

```
  t=0s          t=30s         t=90s          t=120s
   │             │              │               │
   │  電卓起動    │  操作1       │  (TTL expire) │  操作2
   │  baseline   │  diffMode    │               │  diffMode
   │  作成       │              │               │
   ▼             ▼              ▼               ▼
 ┌────┐       ┌────┐         ┌────┐          ┌────┐
 │base│       │diff│         │XXXX│          │full│
 │line│       │ OK │         │消失 │          │復活 │
 └────┘       └────┘         └────┘          └────┘

 hints.caches.diffBaseline:
 ┌────────────────────────────────────────────────────────┐
 │ t=0s:   {exists:true, ageMs:0,     expiresIn:90000}    │
 │ t=30s:  {exists:true, ageMs:30000, expiresIn:60000}    │
 │ t=90s:  {exists:false, invalidatedBy:"ttl"}            │
 │ t=120s: {exists:true, ageMs:0, degradedToFull:true,    │
 │          invalidatedBy:"ttl"}  ← 前回の失効理由を保持    │
 └────────────────────────────────────────────────────────┘
```

LLM は `ageMs` と `expiresIn` を見て「あと何秒で失効するか」を常時把握できる。
失効後も `invalidatedBy` で「なぜ失効したか」が分かる。

---

#### シーケンス図 — 同一性の失効（アプリ再起動）

```
  LLM                  MCP                      Windows
   │                    │                         │
   │  workspace_launch  │                         │
   │──────────────────>│  CreateProcess           │
   │                    │────────────────────────>│
   │                    │                         │ ┌─ 電卓 ─┐
   │                    │  HWND=0x1234            │ │ pid   │
   │                    │  pid=5678               │ │ 5678  │
   │                    │  startTime=10000        │ │ start │
   │                    │<────────────────────────│ │ 10000 │
   │  target:{0x1234,   │                         │ └───────┘
   │    5678, 10000}    │                         │
   │<──────────────────│                         │
   │                    │                         │
   │  click_element "5" │                         │
   │──────────────────>│────────────────────────>│ [5] clicked
   │                    │                         │ baseline 保存
   │                    │                         │
   │                    ・・・ユーザが裏で操作・・・      │
   │                    │                         │ ┌─ 電卓 × ─┐
   │                    │                         │ │ closed   │
   │                    │                         │ └──────────┘
   │                    │                         │ ┌─ 電卓 ──┐
   │                    │                         │ │ pid    │
   │                    │                         │ │ 9999   │ (新)
   │                    │                         │ │ start  │
   │                    │                         │ │ 20000  │
   │                    │                         │ └────────┘
   │                    │                         │
   │  screenshot        │                         │
   │  (diffMode=true)   │                         │
   │──────────────────>│  EnumWindows + identity │
   │                    │────────────────────────>│
   │                    │  HWND=0x???, pid=9999  │
   │                    │<────────────────────────│
   │                    │                         │
   │                    │  identity 比較:          │
   │                    │  旧 pid=5678 ≠ 新 9999  │
   │                    │  → "process_restarted"  │
   │                    │                         │
   │<──────────────────│                         │
   │  hints.target.pid=9999                       │
   │  hints.caches.diffBaseline: {                │
   │    exists: false,                            │
   │    invalidatedBy: "process_restarted",       │
   │    previousTarget: {                         │
   │      pid: 5678, processName: "CalculatorApp" │
   │    }                                         │
   │  }                                           │
   │                    │                         │
   │  LLM: 「前提リセット、直前の操作履歴は無効」    │
```

#### 失効理由の分類表

```
  ┌──────────────────────────┬────────────────────────────┐
  │ 失効理由 (invalidatedBy)  │ 起因                        │
  ├──────────────────────────┼────────────────────────────┤
  │ "ttl"                    │ 90 秒経過                   │
  │ "workspace_snapshot"     │ workspace_snapshot 呼び出し │
  │ "manual_clear"           │ 明示 clearLayers()         │
  │ "hwnd_vanished"          │ HWND が EnumWindows に無い  │
  │ "hwnd_reused"            │ 同 HWND だが別 pid (危険)   │
  │ "process_restarted"      │ 同 title だが pid 異なる    │
  └──────────────────────────┴────────────────────────────┘
```

---

### 1.3 wait_until — 待ちのループをサーバ側に寄せる

**Before** — LLM がスクショで自己ポーリング:

```
  LLM                              MCP
   │                                │
   │  workspace_launch("電卓")       │
   │───────────────────────────────>│
   │                                │──┐
   │<───────────────────────────────│  │ 非同期で起動中
   │  {launched:true, pid:...}      │  │
   │                                │  │
   │  screenshot() — まだ?           │  │
   │───────────────────────────────>│  │
   │<───────────────────────────────│  │  ~500 token
   │  まだ出てない                    │  │
   │                                │  │
   │  screenshot() — まだ?           │  │
   │───────────────────────────────>│<─┘ 電卓 appeared
   │<───────────────────────────────│
   │  まだ出てない                    │     ~500 token
   │                                │
   │  screenshot() — まだ?           │
   │───────────────────────────────>│
   │<───────────────────────────────│     ~500 token
   │  出た！                         │
   │                                │
  合計: 3〜5 回、~1500〜2500 token 浪費
```

**After** — wait_until でサーバが 1 回で答える:

```
  LLM                              MCP (pollUntil)
   │                                │
   │  workspace_launch("電卓")       │
   │───────────────────────────────>│
   │<───────────────────────────────│
   │                                │
   │  wait_until({                  │
   │    condition:"window_appears", │
   │    target:{windowTitle:"電卓"}, │
   │    timeoutMs: 5000             │
   │  })                            │
   │───────────────────────────────>│──┐
   │                                │  │ 200ms ポーリング
   │                                │  │ EnumWindows x N
   │                                │  │
   │                                │<─┘ 電卓 appeared (820ms)
   │<───────────────────────────────│
   │  ok({                          │
   │    elapsedMs: 820,             │
   │    observed: {                 │
   │      windowTitle: "電卓",       │
   │      hwnd: 0x1234,             │
   │      pid: 5678                 │
   │    }                           │
   │  })                            │
   │                                │
  合計: 1 回、~100 token
```

---

### Phase 1 完了後に LLM が見える世界（応答の断面図）

`click_element("電卓", "5")` の応答例:

```
┌─────────────────────────────────────────────────────┐
│  ok({                                                │
│    element: "5",                                     │
│    reason: "matched Name='5'",          ← 理想 2     │
│                                                      │
│    post: {                               ← 理想 1    │
│      focusedWindow: "電卓",                          │
│      focusedElement: "display",                      │
│      windowChanged: false,                           │
│      elapsedMs: 42                                   │
│    },                                                │
│                                                      │
│    hints: {                                          │
│      target: {                           ← 同一性     │
│        hwnd: 0x1234,                                 │
│        pid: 5678,                                    │
│        processName: "CalculatorApp",                 │
│        processStartTimeMs: 10000,                    │
│        titleResolved: "電卓"                          │
│      },                                              │
│      caches: {                           ← 時間      │
│        diffBaseline: {                               │
│          exists: true,                               │
│          ageMs: 3200,                                │
│          expiresInMs: 86800                          │
│        },                                            │
│        uiaCache: {                                   │
│          exists: true,                               │
│          ageMs: 1100,                                │
│          expiresInMs: 88900                          │
│        }                                             │
│      }                                               │
│    }                                                 │
│  })                                                  │
└─────────────────────────────────────────────────────┘
```

LLM が一目で把握できるもの:
- **何をクリックしたか**（element, reason）
- **今どこにいるか**（post.focusedWindow / Element）
- **同じ電卓インスタンスを触っているか**（hints.target.pid + startTime）
- **diff は有効か、あと何秒で失効するか**（hints.caches.diffBaseline）

これまで:
- 座標 `(1182, 141)` をクリックして結果不明 → スクショで再確認

Phase 1 完了後:
- セマンティックな操作 + 世界の状態 + 信頼できる時間軸 → **スクショなしで次の一手が決まる**

---

## Phase 2 — 言語化層

### 2.1 最小ポスト状態 narration（理想 1 の常時 ON 最小版）
**Why**: 福笑い感解消の核心。全 action 系ツールで ~30 トークン追加するだけで、LLM はスクショ確認呼び出しを省ける。
**Shape** — 全 action tools の応答末尾に `post`:
```ts
post: {
  focusedWindow: string | null,
  focusedElement: string | null,       // UIA Name or selector
  windowChanged: boolean,               // 前フォアグラウンド HWND との差分
  elapsedMs: number
}
```
**Where**: 新規 `src/tools/_post.ts` に `withPostState(handler)` を実装 → 以下に適用:
- `click_element`, `set_element_value`（`src/tools/ui-elements.ts`）
- `keyboard_press`, `keyboard_type`（`src/tools/keyboard.ts`）
- `mouse_click`, `mouse_drag`（`src/tools/mouse.ts`）
- `browser_click_element`, `browser_navigate`, `browser_eval`（`src/tools/browser.ts`）

`mouse_move` / `scroll` / `get_cursor_position` は対象外（状態遷移ではない）。
**実装メモ**: フォーカス要素の取得は軽量に。既存 `getActiveWindow` + UIA のフォーカス要素 1 発取得（子孫列挙なし）で済ませる。

### 2.2 why / state hints の拡張（理想 2）
**Where**: `src/tools/screenshot.ts:428-442` の hints 組み立て、および `uia-bridge.ts` の actionable 生成部
**How**:
- 各 actionable に `state: "enabled" | "disabled" | "toggled" | "readonly"` を追加（UIA の `IsEnabled` / `TogglePattern.ToggleState` を反映）
- `click_element` / `set_element_value` の成功応答に `reason: "matched automationId='multiplyButton'"` を含める（マッチ根拠の明示）
- `disabled` 要素を操作しようとしたとき、事前検知して `fail({ code:"ElementDisabled", suggest:["Wait for enable via wait_until(value_changes)"] })`

### 2.3 OCR 信頼度の露出（理想 4a）
**Where**: `src/engine/ocr-bridge.ts` → Windows OCR API `OcrLine.Confidence` を拾う
**How**:
- `actionable[]` の `source:"ocr"` アイテムに `confidence: 0..1` を付与
- screenshot 応答の `hints.lowConfidenceCount` を追加
- `confidence < 0.5` のアイテムには自動で `suggest:"Use dotByDot screenshot or browser_eval for verification"` を付ける

---

## Phase 2 図解

### 2.1 post narration の適用範囲 — どのツールに常時 ON か

```
  ┌──────────────────────────────────────────────────────────┐
  │  適用対象（状態遷移するツール）  ← ~30 token の post 付与    │
  ├──────────────────────────────────────────────────────────┤
  │   click_element            set_element_value              │
  │   keyboard_type            keyboard_press                 │
  │   mouse_click              mouse_drag                     │
  │   browser_click_element    browser_navigate               │
  │   browser_eval                                            │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │  除外（観測・非遷移ツール）                                   │
  ├──────────────────────────────────────────────────────────┤
  │   mouse_move              scroll                          │
  │   get_cursor_position     screenshot                      │
  │   get_windows             get_ui_elements                 │
  └──────────────────────────────────────────────────────────┘
```

---

### 2.1 応答の Before / After — click_element の例

```
  Before (~10 token)                After (~40 token)
  ┌──────────────────┐              ┌──────────────────────────────┐
  │ ok({             │              │ ok({                          │
  │   element: "5"   │              │   element: "5",               │
  │ })               │              │   reason: "matched Name='5'", │
  └──────────────────┘              │   post: {                     │
                                    │     focusedWindow: "電卓",     │
  LLM: 「クリックできた。           │     focusedElement: "display",│
        でも本当に                  │     windowChanged: false,     │
        効いた？」                  │     elapsedMs: 42             │
            │                       │   }                           │
            ▼                       │ })                            │
   screenshot(diffMode=true)       └──────────────────────────────┘
   で確認する（~500 token）                  │
                                             ▼
                                  LLM: 「focus 電卓のまま、
                                        display に値が入った。
                                        次の操作へ」
                                        （スクショ不要）
```

**差引**: +30 token の post で、~500 token のスクショ確認を省ける。

---

### 2.2 state による事前検知（理想 2）

```
  click_element("送信") 呼び出し時のフロー
  ─────────────────────────────────────────

                click_element("送信")
                      │
                      ▼
              UIA で要素取得
                      │
                      ▼
            ┌── state 判定 ──┐
            │                 │
   ┌────────┴─────┬──────────┴───┬────────────┐
   ▼              ▼              ▼            ▼
 enabled       disabled      toggled      readonly
   │              │              │            │
   ▼              ▼              ▼            ▼
 Invoke      fail({        Invoke +      fail({
 実行        code:         reason:       code:
             "Element      "ToggleState  "ReadOnly",
             Disabled",    was Off"      suggest:[
             suggest: [                   "Try set_
               "Wait via                  element_
               wait_until                 value"
               (value_                    ]
               changes)"                 })
             ]})
```

従来は disabled ボタンをクリックしても成功扱いで何も起きず、LLM は原因不明の再試行に入っていた。

---

### 2.3 OCR 信頼度 — 低信頼項目への自動 suggest

```
  screenshot(detail='text') on Paint のケース
  ─────────────────────────────────────────────

       UIA returns 0 elements (WinUI3)
                  │
                  ▼
       Windows OCR fallback 発火
                  │
                  ▼
  ┌───────────────────────────────────────────────────────┐
  │  actionable: [                                         │
  │    {                                                   │
  │      text: "ファイル",                                  │
  │      confidence: 0.95,  ← OcrLine.Confidence 由来       │
  │      source: "ocr",     ★★★★★                         │
  │      clickAt: {x:23, y:15}                             │
  │    },                                                  │
  │    {                                                   │
  │      text: "編集",                                     │
  │      confidence: 0.88,                                 │
  │      source: "ocr",     ★★★★                          │
  │    },                                                  │
  │    {                                                   │
  │      text: "Hョ「5",       ← 文字化け                   │
  │      confidence: 0.23,                                 │
  │      source: "ocr",     ★                             │
  │      suggest: "Use dotByDot screenshot or              │
  │                browser_eval for verification"          │
  │    }                                                   │
  │  ],                                                    │
  │  hints: {                                              │
  │    lowConfidenceCount: 1,                              │
  │    ocrFallbackFired: true                              │
  │  }                                                     │
  └───────────────────────────────────────────────────────┘
                  │
                  ▼
  LLM: 「3 つ目は怪しいので dotByDot で再確認してからクリック」
```

---

## Phase 3 — 文脈 API と opt-in 拡張

### 3.1 文脈取得ツール群（理想 3）

**設計判断**: 「現在の状態」は観測対象のレベルが異なる（OS / アプリ / ドキュメント / 行動履歴）ため、1 ツールに詰め込まず **3 つに分ける**。LLM が用途に応じて選択。

#### 3.1.a `get_context()` — OS + アプリレベル（軽量）
```ts
get_context() → ok({
  // OS レベル
  focusedWindow: { title: string; processName: string; hwnd: number } | null,
  cursorPos: { x: number; y: number },
  cursorOverElement: { name: string; type: string } | null,  // UIA ElementFromPoint

  // アプリレベル
  focusedElement: { name: string; type: string; value?: string } | null,  // UIA FocusedElement
  hasModal: boolean,
  pageState: "ready" | "loading" | "dialog" | "error"
})
```
- `screenshot(detail='meta')` より意味情報が豊かで `detail='text'` より桁で安い
- UIA は軽量呼び出し（子孫列挙なし、focus 1 要素のみ）
- **Where**: 新規 `src/tools/context.ts`

#### 3.1.b `get_history(n?)` — 行動履歴
```ts
get_history({ n?: number = 5 }) → ok({
  actions: Array<{
    tool: string,
    argsDigest: string,       // 要点のみ（フル args は省略）
    post: PostState,          // Phase 2.1 の post
    elapsedMs: number,
    tsMs: number
  }>
})
```
- 直近 N アクションの post 列。「今自分は何をやっていた途中か」を LLM が再構成するため
- リングバッファは `_post.ts` に同居、`withPostState` の副作用として更新
- MCP セッション寿命で揮発（永続化しない）

#### 3.1.c `get_document_state()` — ドキュメントレベル（Chrome 相手）
```ts
get_document_state({ port?, tabId? }) → ok({
  url: string,
  title: string,
  readyState: "loading" | "interactive" | "complete",
  selection?: string,         // window.getSelection().toString()
  scroll: { x: number; y: number; maxY: number }
})
```
- CDP 経由。`browser_eval` で 1 回のスクリプト評価に詰め込める
- ブラウザ編集中の文脈把握用

### 3.2 リッチ narration（理想 1 の opt-in 版）
**Trigger**: 各 action ツールの `narrate: "rich"` フラグ
**Payload**: `post` に加えて:
```ts
post.rich: {
  appeared: Array<{ name: string; type: string }>,    // 新規に出現した actionable
  disappeared: Array<{ name: string }>,
  valueDeltas: Array<{ name: string; before: string; after: string }>,
  navigation?: { fromUrl: string; toUrl: string }
}
```
**Cost**: trigger したときのみ UIA 差分取得（`layer-buffer` の diff と同じロジック流用）。LLM が「確認スクショなしに全景把握したい」とき専用。

### 3.3 UIA 信頼度合成（理想 4b）
**Where**: `uia-bridge.ts` の `actionable[]` 生成
**How**: マッチ方法から synthetic confidence を算出:
- `automationId` 完全一致 → 1.0
- `Name` 完全一致 → 0.95
- `Name` 部分一致 (substring) → 0.7
- `Name` fuzzy 一致 → 0.5

`source:"uia"` アイテムにも `confidence` フィールドを統一的に持たせ、OCR / UIA 横断で比較可能に。

---

### 3.4 非同期イベント subscribe（ターン間の状態差分 push）

**設計メモ**: MCP プロトコルは `notifications/*` による server→client push を持つ。ただし LLM はターンベースなので、リアルタイム反応はできない。**現実的に意味があるのは「次の LLM ターンの冒頭に、前ターン以降に起きたイベント差分を文脈として注入する」パターン**。

#### 3.4.a サーバ側実装
- 新規 `src/engine/event-bus.ts`: HWND 列挙の ~500ms ポーリングで以下のイベントを検出
  - `window_appeared` / `window_disappeared`
  - `foreground_changed`
  - `modal_opened` / `modal_closed`
- MCP `notifications/message` で client に push

#### 3.4.b `events/subscribe` 風ツール
```ts
events_subscribe({ types: string[] }) → ok({ subscriptionId })
events_poll({ subscriptionId, sinceMs?: number }) → ok({ events: [...] })
events_unsubscribe({ subscriptionId })
```
- MCP notifications を解さないクライアント向けの**ポーリング型フォールバック**
- クライアントが notifications を処理するなら subscribe + push、しないなら poll で読む

#### 3.4.c 判断
- **Phase 3 の中で最後に着手**。他の要素（特に `get_context` / `get_history`）で LLM が「今どこ」を取れるようになってから、残差として push の価値を評価
- **macro 中間進捗の push（`notifications/progress`）は見送り**: `stop_on_error` で足りる。長時間マクロでのみ価値があり、現時点では要求が薄い

---

## Phase 3 図解

### 3.1 文脈取得の観測レベル — 3 ツールの責務分担

LLM が「今どこにいるか」を知りたいとき、観測対象のレベルが 4 段階ある。1 つのツールに詰め込まず責務で分離する。

```
  観測レベル        ツール              主な応答フィールド
  ─────────────────────────────────────────────────────────────
  OS / ウィンドウ │ get_context()   │ focusedWindow
                  │                │ cursorPos, cursorOverElement
  ────────────────┼────────────────┼──────────────────────────
  アプリ内        │ get_context()  │ focusedElement
                  │                │ hasModal, pageState
  ────────────────┼────────────────┼──────────────────────────
  ドキュメント    │ get_document_  │ url, readyState
  （Chrome）      │ state()        │ selection, scroll
  ────────────────┼────────────────┼──────────────────────────
  行動履歴        │ get_history()  │ actions[].tool
                  │                │ actions[].post
                  │                │ actions[].elapsedMs
  ─────────────────────────────────────────────────────────────
```

**コスト感**: `get_context()` は UIA 子孫列挙なし・フォーカス 1 要素のみなので
`screenshot(detail='text')` の **1/10 以下**のトークンで済む。

```
  コスト比（イメージ）:
  ┌──────────────────────────────────────────────────────────┐
  │ screenshot(detail='image')  ████████████████████ 4000tok │
  │ screenshot(detail='text')   ████████░░░░░░░░░░░░ 1500tok │
  │ screenshot(detail='meta')   ██░░░░░░░░░░░░░░░░░░  400tok │
  │ get_context()               █░░░░░░░░░░░░░░░░░░░  ~80tok │
  │ get_history(n=3)            █░░░░░░░░░░░░░░░░░░░  ~120tok│
  │ get_document_state()        █░░░░░░░░░░░░░░░░░░░  ~60tok │
  └──────────────────────────────────────────────────────────┘
```

---

### 3.2 リッチ narration — opt-in で全景把握

通常の `post`（常時 ON、~30 tok）と `narrate:"rich"` を指定したときの `post.rich`（opt-in、~200 tok）の差:

```
  click_element("Submit", narrate:"minimal")  ← 通常（常時 ON）
  ┌──────────────────────────────────────┐
  │  post: {                             │  ~30 トークン
  │    focusedWindow: "Webフォーム",      │
  │    focusedElement: "Submit ボタン",   │
  │    windowChanged: false,             │
  │    elapsedMs: 38                     │
  │  }                                   │
  └──────────────────────────────────────┘

  click_element("Submit", narrate:"rich")  ← opt-in
  ┌──────────────────────────────────────┐
  │  post: {                             │  ~200 トークン
  │    focusedWindow: "Webフォーム",      │
  │    focusedElement: "Thanks page h1", │
  │    windowChanged: false,             │
  │    elapsedMs: 312,                   │
  │    rich: {                           │
  │      appeared: [                     │  ← 新登場 UI
  │        { name:"Thanks!", type:"Text"}│
  │        { name:"Back", type:"Button"} │
  │      ],                              │
  │      disappeared: [                  │  ← 消えた UI
  │        { name:"Submit" },            │
  │        { name:"Name field" }         │
  │      ],                              │
  │      valueDeltas: [                  │  ← 値の変化
  │        { name:"progress",            │
  │          before:"0%", after:"100%"}  │
  │      ],                              │
  │      navigation: null                │  ← ページ遷移なし
  │    }                                 │
  │  }                                   │
  └──────────────────────────────────────┘
```

**使い分け**:
- `narrate:"minimal"`（省略時デフォルト） — 常時 ON。スクショ確認の代替として操作結果を把握
- `narrate:"rich"` — 確認スクショなしで全景把握したいとき（フォーム送信後・ページ遷移後など）

---

### 3.3 UIA 信頼度合成 — OCR / UIA 横断で比較可能に

Phase 2.3 で OCR に `confidence` が付いたが、UIA も同じ軸で揃える。

```
  ┌────────────────────────────────────────────────────────────────┐
  │ 要素検索の方法              source  confidence  安定性         │
  ├────────────────────────────────────────────────────────────────┤
  │ automationId 完全一致       uia     1.00        ★★★★★        │
  │ Name 完全一致               uia     0.95        ★★★★☆        │
  │ Name 部分一致 (substring)   uia     0.70        ★★★☆☆        │
  │ Name fuzzy 一致             uia     0.50        ★★☆☆☆        │
  ├────────────────────────────────────────────────────────────────┤
  │ OCR（高信頼）               ocr     0.85〜1.0   ★★★★☆        │
  │ OCR（中信頼）               ocr     0.50〜0.85  ★★★☆☆        │
  │ OCR（低信頼）               ocr     < 0.50      ★☆☆☆☆        │
  │  → suggest: dotByDot screenshot / browser_eval              │
  └────────────────────────────────────────────────────────────────┘
```

OCR と UIA が同じ `confidence` スケールを持つことで、LLM は
「UIA fuzzy（0.50）と OCR 高信頼（0.87）のどちらを信じるか」を定量的に判断できる。

```
  LLM が受け取る actionable[] の例:
  [
    { name:"乗算",  source:"uia", confidence:1.00, clickAt:{x:...,y:...} },
    { name:"=",     source:"uia", confidence:0.95, clickAt:{x:...,y:...} },
    { name:"29,232",source:"ocr", confidence:0.91, clickAt:{x:...,y:...} },
    { name:"Hョ...", source:"ocr", confidence:0.23,           ← ★低信頼
      suggest:"Use dotByDot screenshot or browser_eval" }
  ]
```

---

### 3.4 ターン間イベント — before / after

LLM はターンベース動作のためリアルタイム push に反応できない。
しかしターンの境界で「前ターン以降に何が起きたか」を注入すれば、ほぼ等価な情報が得られる。

**Before（Phase 3 なし）** — ターン間の出来事は LLM に届かない:

```
  Turn 1                Turn 2                Turn 3
  LLM                   LLM                   LLM
  │                     │                     │
  │ click_element("OK") │                     │ screenshot()
  │──────────>  MCP     │                     │──────────> MCP
  │ <──────────         │                     │ <──────────
  │ ok(...)             │                     │ (全景)
  │                     │
  │             ▲ この間にユーザがアプリを切り替えた
  │             │ ダイアログが出た
  │             │ ウィンドウが閉じた
  │             │ → LLM は何も知らない
  │             │
                ∅（何も届かない）
```

**After（events_subscribe + events_poll）** — ターン開始時に差分注入:

```
  Turn 1                           Turn 2
  LLM                  MCP (event-bus)        LLM
  │                     │                     │
  │ events_subscribe    │  500ms poll loop ─┐ │
  │ ({types:[           │  EnumWindows      │ │
  │   "window_appeared",│                   │ │
  │   "foreground_      │                   │ │
  │   changed"]})       │                   │ │
  │──────────────────>  │                   │ │
  │ <──────────────────  │                   │ │
  │ {subscriptionId:    │                   │ │
  │   "sub-001"}        │                   │ │
  │                     │  [foreground_changed] ← ユーザが切替
  │                     │  [modal_opened]    │ │
  │                     │  [window_appeared] ←┘ メモ帳が起動
  │                     │                     │
  │                     │                     │ Turn 2 先頭で
  │                     │                     │ events_poll()
  │                     │                     │──────────────> MCP
  │                     │                     │ <──────────────
  │                     │                     │ ok({ events: [
  │                     │                     │   {type:"foreground_changed",
  │                     │                     │    from:"電卓", to:"Chrome"},
  │                     │                     │   {type:"modal_opened",
  │                     │                     │    windowTitle:"名前を付けて保存"},
  │                     │                     │   {type:"window_appeared",
  │                     │                     │    windowTitle:"無題 - メモ帳"}
  │                     │                     │ ]})
  │                     │                     │
  │                     │                     │ LLM: 「前ターン以降に
  │                     │                     │       3 件のイベントあり。
  │                     │                     │       ダイアログが出ている」
  │                     │                     │ → 次の操作を再考
```

**push / poll の使い分け**:

```
  ┌─────────────────────────────────────────────────────────┐
  │ MCP notifications 対応クライアント（Claude Desktop 等）  │
  │                                                         │
  │   event-bus ──notifications/message──> クライアント     │
  │                                         ↓              │
  │                                       次ターンで自動注入 │
  └─────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────┐
  │ notifications 非対応クライアント                         │
  │                                                         │
  │   LLM が毎ターン先頭で events_poll() を呼ぶ             │
  │   → バッファされたイベント差分を取得                     │
  │   → 実質的に同じ情報を得られる                           │
  └─────────────────────────────────────────────────────────┘
```

---

## Phase 4 — 意図ベース複合操作（別計画）

Phase 3 完了後に実使用を観察してから計画化。候補:
- `fill_form(window, fields)` — 複数 `set_element_value` の原子合成
- `navigate_to(window, url)` — `browser_navigate` + `wait_until(ready_state)` の糖衣
- `workspace_scene` — 名付けワークスペース（現状 `DESKTOP_TOUCH_DOCK_TITLE` 単発のみ）
- `notifications/progress` による macro 中間状態 push

Phase 0〜3 が入れば `run_macro` + `wait_until` で多くの意図操作が LLM 側で組めるため、まず使用状況を見てから判断する。

---

## 主要修正ファイル

| ファイル | 主な変更 | Phase |
|---|---|---|
| `src/tools/_types.ts` | ToolSuccess / ToolFailure 型、ok / fail ヘルパー | 0 |
| `src/engine/poll.ts`（新） | pollUntil 共通化 | 0 |
| `src/tools/browser.ts:664`, `workspace.ts:204`, `dock.ts:314` | pollUntil に置換 | 0 |
| `src/tools/_errors.ts`（新） | ToolError, failWith, suggest 辞書 | 1 |
| `src/index.ts:175-185` | failsafe ラッパーと ToolError 連携 | 1 |
| `src/engine/layer-buffer.ts:296-307` | 既存 UIA キャッシュ API を配線、identity チェック追加 | 1 |
| `src/engine/window-cache.ts:46-49` | invalidation 理由（vanished/reused/restarted）を分類 | 1 |
| `src/engine/uia-bridge.ts:275` | `cached?` オプション、ヒット時差分応答 | 1 |
| Win32 ブリッジ（pid / processStartTimeMs 取得） | HWND から identity を引く関数追加 | 1 |
| `src/tools/ui-elements.ts`, `keyboard.ts`, `mouse.ts`, `browser.ts` | wait_until 登録、post フィールド付与 | 1〜2 |
| `src/tools/macro.ts:35-59` | TOOL_REGISTRY に wait_until 追加 | 1 |
| `src/tools/_post.ts`（新） | withPostState、リングバッファ | 2 |
| `src/tools/screenshot.ts:428-442` | hints に state 拡張、OCR confidence | 2 |
| `src/engine/ocr-bridge.ts` | OcrLine.Confidence の露出 | 2 |
| `src/tools/context.ts`（新） | get_context / get_history / get_document_state ハンドラ | 3 |
| `src/engine/uia-bridge.ts` | synthetic confidence、rich narration 用 diff | 3 |
| `src/engine/event-bus.ts`（新） | HWND ポーリング + notifications/message 発火 | 3 |
| `src/tools/events.ts`（新） | events_subscribe / events_poll ハンドラ | 3 |
| `src/index.ts:21-167` | LLM 指示文を新形状に合わせて更新 | 各 Phase |

---

## 検証プラン

各 Phase ごとに以下を通す:

1. **ビルド**: `npm run build`（tsc）がクリーン通過
2. **既存 E2E**: `tests/e2e/` の 4 本（`browser-cdp.test.ts` / `dock-auto.test.ts` / `dock-window.test.ts` / `process-tree.test.ts`）がグリーン
3. **MCP 手触り検証**（desktop-touch MCP 自体を使う）:
   - **Phase 0**: `run_macro` で失敗ステップを含むシナリオ実行 → 構造化エラーが `ToolError` 形で返ることを確認
   - **Phase 1 (1.1)**: 存在しないウィンドウ名で `click_element` → `code:"WindowNotFound"` + suggest 配列が返る
   - **Phase 1 (1.2.a)**: 電卓で `get_ui_elements(cached=false)` → `get_ui_elements(cached=true)` を連続 → 2 回目が `hints.uiaCached:true` + 差分応答
   - **Phase 1 (1.2.b/c)**: 電卓操作 → baseline 保持を確認 → 電卓を閉じて再起動 → `screenshot(diffMode=true)` で `invalidatedBy:"process_restarted"` と `previousTarget` が返る。`hints.target.pid` が新 pid
   - **Phase 1 (1.2.c)**: 90 秒待機後の `screenshot(diffMode=true)` → `invalidatedBy:"ttl"`。`workspace_snapshot` 直後なら `invalidatedBy:"workspace_snapshot"`
   - **Phase 1 (1.3)**: `wait_until({condition:"window_appears", target:{windowTitle:"電卓"}})` を発火させ、手動で電卓を起動 → observed に電卓ウィンドウ情報
   - **Phase 2 (2.1)**: 電卓で `click_element("5")` → `post.focusedWindow:"電卓"`, `post.focusedElement` が更新される
   - **Phase 2 (2.2)**: 無効化されたボタンを `click_element` → `ElementDisabled` エラー
   - **Phase 2 (2.3)**: 低解像度スクショで OCR を強制 → 低 confidence アイテムに suggest
   - **Phase 3 (3.1.a)**: `get_context()` を呼び、`screenshot(detail='meta')` とトークン量比較（meta より情報量多く、text より桁下）。focused/cursor の 2 系統が分離されて返る
   - **Phase 3 (3.1.b)**: いくつか操作後に `get_history(n=3)` を呼び、post 列が時系列で返る
   - **Phase 3 (3.1.c)**: Chrome を CDP 接続中に `get_document_state()` → URL / readyState / selection が返る
   - **Phase 3 (3.2)**: `click_element("Submit", narrate:"rich")` → `post.rich.valueDeltas` に変化が列挙される
   - **Phase 3 (3.3)**: automationId マッチと fuzzy マッチで confidence 値に差が出る
   - **Phase 3 (3.4)**: `events_subscribe({types:["window_appeared"]})` → 手動でメモ帳起動 → `events_poll` で appeared イベントが取れる
4. **新規単体テスト**: 各 Phase ごとに `tests/unit/` 配下へ（現状ディレクトリ未整備の可能性 → 必要なら vitest 設定追記）。特に:
   - `poll.test.ts`（Phase 0）
   - `errors.test.ts` — suggest 辞書のマッピング（Phase 1）
   - `post-narration.test.ts`（Phase 2）

---

## 実装の進め方

1. Phase 0.1（出力型）→ 0.2（pollUntil）の順で足場を固める
2. Phase 1.1 → 1.2 → 1.3 の順で P0 を投入
3. 各 Phase の MCP 手触り検証を通し、前進感を確かめてから次へ
4. Phase 3.4（非同期 push）は Phase 3 の最後に着手し、先行要素の実用性を見てから判断
