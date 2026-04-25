# E2E Test Plan — anti-fukuwarai + terminal + CDP-search

> 2026-04-13 — Opus 企画。大規模改造 (Phase 1.2-3.4 + terminal/CDP-search, 4 commits `f79f6e7` / `c147234` / `f69b071` / `bec8721`) 後の E2E 計画。
> 本ファイルは `docs/e2e-*.md` が `.gitignore` 対象のためローカル限定保管。

## 1. 全体戦略

「handler を直接呼ぶ・CLI ツールは spawn で起動する・既存の helper 命名規則を踏襲する」の 3 原則で、既存 4 スイートの書き味を壊さない。ハンドラを `src/tools/*.ts` から import して `await Handler({...})` を叩き、`JSON.parse((r.content[0] as {text:string}).text)` で payload を取り出す（`dock-window.test.ts` と同形）。被験体 (victim) は Notepad / PowerShell / Chrome の 3 種に絞り、ユニーク tag を差し込むことで他インスタンスとの衝突を回避（`dock-window.test.ts` の `UNIQUE_TAG` パターン踏襲）。`vitest.config.ts` が `sequence.concurrent=false` なので suite 間のフォーカス競合は起きない前提で書けるが、**suite 内**は順序依存になりうる — `beforeAll` で victim を立て、`afterAll` で確実に kill。identity tracker / event-bus はモジュールスコープで状態を保持するので suite ごとに `clearIdentities()` をエクスポートして呼ぶ必要がある（今は export 済み）。

---

## 2. テスト suite 一覧

| Suite | 含むケース | 所要 | 依存環境 | 優先 |
|---|---|---|---|---|
| `tests/e2e/terminal.test.ts` | `terminal_read` PowerShell 経由 UIA / OCR 強制 / sinceMarker diff / stripAnsi / `terminal_send` 実送信・Enter 押下・focus 復元 / `TerminalWindowNotFound` | ~15s | PowerShell (pwsh or powershell.exe), `typeViaClipboard` 動作可 | 🔴 最高 |
| `tests/e2e/wait-until.test.ts` | 8 条件: window_appears/disappears, focus_changes, element_appears (Notepad), value_changes, ready_state, terminal_output_contains, element_matches (CDP) / WaitTimeout / hook 未登録エラー | ~25s | Notepad + PowerShell + Chrome (一部は HEADED) | 🔴 最高 |
| `tests/e2e/events.test.ts` | subscribe → Notepad spawn → poll → window_appeared / Notepad kill → window_disappeared / focus_changed / drain=false peek / sinceMs filter / unsubscribe タイマー停止 / list | ~10s | Notepad, 500ms 待機前提 | 🟡 高 |
| `tests/e2e/context.test.ts` | `get_context` focused/cursorOver/hasModal=false / modal 検出 (タイトル「警告」window)/ `get_history` ring buffer (action を数本走らせて n 件返る) / `get_document_state` readyState="complete" / selection 取得 | ~10s | Notepad, Chrome (CDP) | 🟡 高 |
| `tests/e2e/browser-search.test.ts` | by=text/regex/role/ariaLabel/selector / scope 絞り込み / visibleOnly / inViewportOnly / caseSensitive / maxResults+offset ページング / ScopeNotFound / BrowserSearchNoResults / InvalidRegex | ~15s | Chrome (既存 fixture 拡張) | 🔴 最高 |
| `tests/e2e/hints-identity.test.ts` | screenshot / click_element / set_element_value / scope_element / get_ui_elements / terminal_read が `hints.target` と `hints.caches` を返す / Notepad kill→再起動で `invalidatedBy:"process_restarted"` が立つ / TTL 観測 | ~30s | Notepad, PowerShell | 🟡 高 |
| `tests/e2e/post-narration.test.ts` | mouse_click / mouse_move / keyboard_type / click_element / set_element_value の response に `post: {focusedWindow, windowChanged, elapsedMs}` が入る / 失敗時 post は入らず history の `ok:false` として記録される / `windowChanged=true` が focus 切替で検出される | ~15s | Notepad + 別窓 (calc.exe etc.) | 🟢 中 |
| `tests/e2e/click-disabled.test.ts` | 被験体: 自作 WinForms / PowerShell で disabled button を生成 or Chrome 経由 `<button disabled>` に fallback / `clickElement` が `ElementDisabled` を返し suggest 付き | ~10s | PowerShell (自作 GUI) または Chrome | 🟢 中 |
| `tests/unit/ansi.test.ts` *既存* | `stripAnsi` — SGR / OSC / DEC / CTRL char / `tailLines` — 0/N/超過 | ~1s | pure | 🟢 低（unit） |
| `tests/unit/identity-tracker.test.ts` *既存* | `observeTarget` hwnd_reused / process_restarted / `clearIdentities` / `buildHintsForTitle` 未発見時 null | ~2s | モック enumWindows or 実 Notepad | 🟢 低（unit） |

合計 ~130s（testTimeout 30s 設定の範囲内。serial 実行で ~2.5min）。

---

## 3. 優先度順の実装順序

1. **unit 2 本 (ansi / identity-tracker)**（既存、完了済）
2. **`terminal.test.ts`**（1-2 日） — PowerShell を spawn → enumWindows で titleResolved 取得 → `terminalReadHandler` を叩く。`wait_until(terminal_output_contains)` と `hints.target` のハブなので最優先
3. **`browser-search.test.ts`**（1 日） — `browser-cdp.test.ts` の setup + `test-page.html` に検索対象要素を追加。`wait_until(element_matches)` の前提
4. **`wait-until.test.ts`**（2 日） — 上記 2 hook が揃ってから。hook 未登録時のエラーパスも明示的に検証
5. **`events.test.ts`**（1 日） — 500ms ポーリング許容。Notepad spawn → 1.5s 待機 → poll
6. **`context.test.ts`**（0.5 日） — 軽量。history は in-memory なので `clearHistory` export 追加が前提
7. **`hints-identity.test.ts`**（1 日） — Notepad spawn → kill → 再起動 → `invalidatedBy:"process_restarted"` を観測
8. **`post-narration.test.ts`**（0.5 日） — nut-js 読み込み必要、HEADED 前提推奨
9. **`click-disabled.test.ts`**（1 日） — PowerShell + WinForms で disabled button 自作 (or `<button disabled>` fallback)

---

## 4. 落とし穴と回避策

### 4.1 フォーカス・pin・クリップボード
- **terminal_send は物理的にフォーカスを奪う**。vitest ターミナル自身に paste が混入する事故 → `restoreFocus:true` 固定 + unique tag で「戻ってきた文字」検証。vitest ランナー CLI 窓自身を被験体にしない
- **clipboard 競合**: `typeViaClipboard` が OS clipboard を書き換える → `sequence.concurrent=false` で封殺済だが人間操作中は `HEADED=1` で不安定。README 記載で回避
- **pinned window**: 既知バグ。`terminal_send` テストで被験体を `pin_window` しない

### 4.2 非 US キーボード・IME
- **`typeViaClipboard` は paste 経由なので IME 影響なし**
- **`keyboard.type` direct path** はキーボードレイアウト依存 → 該当テストは ASCII 文字列のみ
- **日本語文字を混ぜた input** は `preferClipboard:true` でのみ安全

### 4.3 仮想デスクトップ
- `enumWindowsInZOrder` は現在の仮想デスクトップの窓しか返さないことがある
- README でテスト前は single-desktop 前提と明記

### 4.4 タイミング問題
- **`events_subscribe` 直後の `poll`**: tick 間隔 500ms。`subscribe` → `spawn` → `await sleep(1500)` → `poll` の sequence
- **`probeFocusChanges` は初回呼び出しで baseline**: `intervalMs:200, timeoutMs:5000` で十分
- **`element_appears` の PowerShell 300ms 起動コスト**: handler 内で `Math.max(intervalMs, 500)` へクランプ済。test 側は `timeoutMs:8000`
- **nut-js の lazy native load**: HEADED 前提に倒す

### 4.5 OCR / 外部バイナリ
- **`terminal_read` の source:"ocr" テスト** は Windows OCR engine 依存 → `process.env.OCR_SKIP === "1"` で skip 可能に
- **Chrome / PowerShell の場所**: spawn 時に `pwsh.exe` / `powershell.exe` の順で try

### 4.6 history ring buffer の suite 横断汚染
- `_post.ts` の `history` 配列はプロセスグローバル。vitest 1 ファイル = 1 プロセスなので分離されるが、同一 suite 内で各 it 冒頭に `clearHistory()` 呼びたい
- **`src/tools/_post.ts` に `export function clearHistory(): void { history.length = 0; }` を追加する必要あり**（現状 export されていない）

### 4.7 identity-tracker の suite 横断汚染
- `clearIdentities()` は既に export 済み。`beforeEach` で呼ぶ

### 4.8 event-bus のタイマー停止
- `events_unsubscribe` で subscriptions.size=0 になれば timer 停止 (`maybeStop`)。テスト末尾で unsubscribe を必ず呼ぶ

---

## 5. 共通 helpers 提案

### `tests/e2e/helpers/powershell-launcher.ts` (新規)
```ts
export interface PsInstance {
  proc: ChildProcess;
  tag: string;               // 窓タイトルに含まれるユニーク識別子
  title: string;             // resolved full title
  hwnd: bigint;              // 観測済み HWND
  kill: () => void;
}

/**
 * Launch a PowerShell window with a deterministic title tag.
 * Uses `$Host.UI.RawUI.WindowTitle = 'tag'` so the window is findable
 * without depending on the exe basename.
 */
export async function launchPowerShell(opts?: { banner?: string }): Promise<PsInstance>;
```
実装骨格: `spawn("powershell.exe", ["-NoExit", "-Command", \`$Host.UI.RawUI.WindowTitle='${tag}'; Write-Host '${banner}'\`], { detached:true, stdio:"ignore" })` → `enumWindowsInZOrder` をポーリングして tag を含むタイトルを待つ

### `tests/e2e/helpers/notepad-launcher.ts` (新規、dock-window から抽出)
```ts
export async function launchNotepad(): Promise<NpInstance>;
```
`dock-window.test.ts` の `beforeAll` ブロックを関数化。再利用側が多い

### `tests/e2e/helpers/wait.ts` (新規)
```ts
export function sleep(ms: number): Promise<void>;
export async function eventually<T>(fn: () => T | null, opts: { timeoutMs: number; intervalMs?: number }): Promise<T>;
```

### `tests/e2e/helpers/chrome-launcher.ts` (既存拡張)
- `ensureChromeCdp(port, fixtureUrl)` を追加

### `tests/e2e/fixtures/test-page.html` (既存拡張)
```html
<button id="btn-regex">Submit Form</button>
<nav role="navigation" id="nav1"><a href="#x">Home</a><a href="#y">About</a></nav>
<input aria-label="Search query" id="search-box">
<button disabled id="btn-disabled">Disabled</button>
<div id="scope-parent"><span>inside</span><span>scope</span></div>
```

### `tests/e2e/helpers/history-reset.ts` (新規)
`_post.ts` に `clearHistory` を足した上で re-export

---

## 6. 受け入れ条件 — E2E が保証すべきこと

### 機能保証
1. **terminal_read** が PowerShell から marker 付きテキストを返し、同じ marker を投げれば空 diff (`text.length=0`) を返す。プロセスを restart すれば `invalidatedBy:"process_restarted"` が立ち、全文に戻る
2. **terminal_send** が unique tag 文字列を PowerShell に届け、1s 以内に `terminal_read` がそれを読み戻せる。`restoreFocus:true` で元フォアグラウンドが復元される
3. **wait_until** の 8 条件すべてが (a) 満たされれば `ok:true, elapsedMs>=0, observed:{...}`、(b) タイムアウトすれば `code:"WaitTimeout"` を返す。hook 未登録時は `ok:false` で即座に返る
4. **browser_search** 5 軸すべてが `test-page.html` 上で期待件数を返し、`scope` / `offset` / `visibleOnly` / `caseSensitive` が独立に機能する。`total` と `returned` が正しく、ページング（offset+maxResults）で被りなく次ページが取れる
5. **events_*** が Notepad spawn/kill を 1.5s 以内に検出し、subscribe/poll/unsubscribe がリーク（active が残らない）を起こさない。`drain:false` で peek が非破壊、`sinceMs` filter が動く
6. **get_context** が focused window を正しく返し、タイトルに「警告」を含む窓が出現したら `hasModal:true` になる
7. **get_document_state** が Chrome の url/title/readyState/scroll を 500ms 以内に返す
8. **get_history** が直近 N 件 (≤20) の action を返し、失敗 action の `ok:false, errorCode:*` が記録されている
9. **click_element** が disabled element に対して `code:"ElementDisabled"` + suggest を返す（silent success ではない）

### 品質保証（横串）
10. **hints.target** が screenshot / click_element / set_element_value / scope_element / get_ui_elements / terminal_read の成功レスポンスすべてに含まれ、`hwnd / pid / processName / processStartTimeMs / titleResolved` の 5 フィールドが揃う
11. **hints.caches** が `diffBaseline / uiaCache / windowLayout` の形状で返る（初回 call では exists:false でも OK）。`workspace_snapshot` 後は `invalidatedBy:"workspace_snapshot"` が立つ
12. **post** block が mouse/keyboard/click_element/set_element_value の成功レスポンスに入り、`focusedWindow / windowChanged / elapsedMs` の 3 必須フィールドを持つ。失敗時は `post` が無いが、history に `ok:false` で記録される
13. **process restart** を観測した直後の tool call が `invalidatedBy:"process_restarted"` を返し、`previousTarget:{pid, processName}` が付く
14. **エラーコード辞書** (`_errors.ts`) の各 code が実際に発火する経路で返る

### 非機能保証
15. スイート合計実行時間が `vitest.config.ts` の制約（testTimeout 30s × serial）内で収まる
16. 任意の suite 単独実行で、他 suite の state (identity, history, event-bus subscriptions) の影響を受けず pass する

---

## 7. 代表的な skeleton

### `terminal.test.ts`
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { terminalReadHandler, terminalSendHandler } from "../../src/tools/terminal.js";
import { launchPowerShell, type PsInstance } from "./helpers/powershell-launcher.js";
import { sleep } from "./helpers/wait.js";

let ps: PsInstance;
const TAG = `pstest-${Date.now().toString(36)}`;

beforeAll(async () => { ps = await launchPowerShell({ banner: `ready-${TAG}` }); }, 15_000);
afterAll(() => ps?.kill());

function parsePayload(r: { content: Array<{ text: string }> }): any {
  return JSON.parse(r.content[0]!.text);
}

describe("terminal_read", () => {
  it("reads PowerShell window via UIA TextPattern", async () => {
    const res = await terminalReadHandler({
      windowTitle: ps.title, lines: 50, stripAnsi: true, source: "auto", ocrLanguage: "ja",
    });
    const p = parsePayload(res);
    expect(p.ok).toBe(true);
    expect(p.text).toContain(`ready-${TAG}`);
    expect(p.source).toBe("uia");
    expect(p.marker).toMatch(/^[a-f0-9]{16}$/);
    expect(p.hints.target.processName.toLowerCase()).toMatch(/powershell|pwsh/);
  });

  it("sinceMarker returns empty diff when no new output", async () => {
    const r1 = parsePayload(await terminalReadHandler({ windowTitle: ps.title, lines: 50, stripAnsi: true, source: "auto", ocrLanguage: "ja" }));
    const r2 = parsePayload(await terminalReadHandler({
      windowTitle: ps.title, lines: 50, stripAnsi: true, source: "auto", ocrLanguage: "ja", sinceMarker: r1.marker,
    }));
    expect(r2.hints.terminalMarker.previousMatched).toBe(true);
    expect(r2.text.length).toBeLessThan(r1.text.length);
  });

  it("fails cleanly for unknown window", async () => {
    const r = parsePayload(await terminalReadHandler({
      windowTitle: "__no_such_terminal_xyz__", lines: 50, stripAnsi: true, source: "auto", ocrLanguage: "ja",
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TerminalWindowNotFound");
    expect(r.suggest).toEqual(expect.arrayContaining([expect.stringMatching(/get_windows/)]));
  });
});

describe("terminal_send", () => {
  it("delivers a unique line that terminal_read can observe", async () => {
    const marker = `sent-${Date.now().toString(36)}`;
    const r = parsePayload(await terminalSendHandler({
      windowTitle: ps.title, input: `echo ${marker}`, pressEnter: true,
      focusFirst: true, restoreFocus: true, preferClipboard: true, pasteKey: "auto",
    }));
    expect(r.ok).toBe(true);
    expect(r.post.elapsedMs).toBeGreaterThan(0);
    await sleep(800);
    const read = parsePayload(await terminalReadHandler({
      windowTitle: ps.title, lines: 100, stripAnsi: true, source: "uia", ocrLanguage: "ja",
    }));
    expect(read.text).toContain(marker);
  });
});
```

### `wait-until.test.ts` (抜粋)
```ts
describe("wait_until(window_appears)", () => {
  it("resolves when a new Notepad appears", async () => {
    const np = await launchNotepad();
    const start = Date.now();
    const r = parsePayload(await waitUntilHandler({
      condition: "window_appears", target: { windowTitle: np.tag }, timeoutMs: 5000, intervalMs: 200,
    }));
    expect(r.ok).toBe(true);
    expect(r.observed.windowTitle).toContain(np.tag);
    expect(Date.now() - start).toBeLessThan(5500);
    np.kill();
  });

  it("times out with WaitTimeout code", async () => {
    const r = parsePayload(await waitUntilHandler({
      condition: "window_appears", target: { windowTitle: "__never_appears__" }, timeoutMs: 500, intervalMs: 100,
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WaitTimeout");
  });
});
```

### `events.test.ts` (抜粋)
```ts
it("reports window_appeared then window_disappeared for Notepad", async () => {
  const sub = parsePayload(await eventsSubscribeHandler({ types: ["window_appeared", "window_disappeared"] }));
  const np = await launchNotepad();
  await sleep(1500);
  const p1 = parsePayload(await eventsPollHandler({ subscriptionId: sub.subscriptionId, drain: true }));
  expect(p1.events.some((e: any) => e.type === "window_appeared" && e.windowTitle.includes(np.tag))).toBe(true);

  np.kill();
  await sleep(1500);
  const p2 = parsePayload(await eventsPollHandler({ subscriptionId: sub.subscriptionId, drain: true }));
  expect(p2.events.some((e: any) => e.type === "window_disappeared")).toBe(true);

  await eventsUnsubscribeHandler({ subscriptionId: sub.subscriptionId });
  const list = parsePayload(await eventsListHandler({}));
  expect(list.active).not.toContain(sub.subscriptionId);
});
```

---

## 参考ファイル（実装時の参照ポイント）

- `tests/e2e/dock-window.test.ts` — victim spawn + unique tag + parsePayload パターン
- `tests/e2e/helpers/chrome-launcher.ts` — 拡張元
- `src/tools/terminal.ts` — terminal_read の marker ロジック / hints.target 形状
- `src/tools/wait-until.ts:268-297` — hook 未登録時のエラー契約
- `src/engine/event-bus.ts:118-135` — ensureRunning / maybeStop（unsubscribe 後の timer 挙動）
- `src/tools/_post.ts:91-100` — 成功時のみ post を差し込む契約
- `src/engine/identity-tracker.ts:101-159` — hwnd_reused / process_restarted の判定ロジック
- `src/tools/_errors.ts:98` — disabled 分類
- `src/engine/uia-bridge.ts:196-202` — click_element の disabled pre-check
- `src/tools/browser.ts:717-958` — browser_search 3s SCAN_BUDGET_MS / 5 軸 / error codes

---

## 工数目安

合計 **8-10 人日**（skeleton 流用で効率化するなら 6 日程度）。優先度 🔴 3 本を最初の 4 日で仕上げれば、anti-fukuwarai core features に対する最低限の regression 網が張れる。
