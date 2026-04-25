# Background Input Plan — フォアグラウンドに出さない入力経路

> 2026-04-18 — 新ツールを追加せず、既存 `terminal_send` / `keyboard_type` / `set_element_value` のパラメータ拡張と内部チャネル切替のみで、フォアグラウンド外のウィンドウ・要素に入力を届けられるようにする設計書。
> 参照: `docs/anti-fukuwarai-ideals-plan.md` / `docs/terminal-integration-plan.md` / `docs/reactive-perception-graph.md`

---

## 0. 目的と制約

### 目的
- **フォーカスがずれていても、LLM が指定したウィンドウ・要素に入力を届ける**（誤爆と前面化ちらつきを減らす）。
- 既存の 56 ツール構成を保ちつつ、**既存ツールのパラメータ追加と内部実装改善のみで達成**する。

### 絶対制約
- **新ツール追加なし**。zod スキーマへの後方互換パラメータ追加のみ。
- 既存パラメータのデフォルト動作は変えない（後方互換）。
- `suggest` / `error` フィールドは固定文（CWE-94 防止、可変値は `context` に）。
- TypeScript + koffi (Win32) + PowerShell (UIA) の 3 層を跨いで実装する。

### 非目標
- 高頻度マクロ入力（ゲーム用途など）の最適化。
- クロスブラウザ全機能サポート（Firefox DevTools などは対象外）。

---

## 1. Phase 構成と依存関係

| Phase | 概要 | 依存 | 優先度 |
|---|---|---|---|
| **A** | `keyboard_type` / `terminal_send` / `keyboard_press` に `method:"auto"\|"background"\|"foreground"` を追加し、WM_CHAR/WM_KEYDOWN 直接注入経路（BG チャネル）を `src/engine/bg-input.ts`（新規）に実装 | `win32.ts` 追加バインディング | **高** |
| **B** | `set_element_value` の内部チャネルを `ValuePattern → TextPattern2.InsertTextAtSelection → CDP → keyboard_type fallback` の自動チェーンに拡張 | Phase A の BG チャネル（keyboard fallback で利用） | **高** |
| **C** | `terminal_send` の BG チャネル最適化（Windows Terminal / conhost 向けの `method:"auto"` 判定・改行処理・focusFirst/restoreFocus 統合） | Phase A の完了 | **高** |

### 実装順序
1. **Phase A を先行完成**（B/C の土台）→ A 境界 Opus レビュー通過後に B/C 並行開始許可。
2. **Phase C は A 完了次第着手**（小変更なので早期完成）。
3. **Phase B は A 完了後に並行着手**（最も複雑、C と並行）。

**リリース区切り**: **v0.14.0 で A + B + C を一括 ship**。ただし feature flag により新チャネルはデフォルト無効 — 従来ユーザーへの影響ゼロを保証する。

### Feature flag ロールアウト

```
# BG チャネル自動選択（method:"auto" の実挙動）
DTM_BG_AUTO=0（デフォルト）  → "auto" は従来の foreground 動作
DTM_BG_AUTO=1                → canInjectViaPostMessage で自動選択

# set_element_value チャネルチェーン
DTM_SET_VALUE_CHAIN=0（デフォルト） → ValuePattern + keyboard fallback のみ
DTM_SET_VALUE_CHAIN=1              → TextPattern2 / CDP チャネルも有効化
```

v0.14.0 では `method:"background"` 明示指定と `DTM_BG_AUTO=1` 設定時のみ BG 動作が変わる。v0.14.1 で flag デフォルト on に切替。

### Opus レビュー境界（全 4 回）

| 境界 | タイミング | 条件 |
|---|---|---|
| A-完了 | Phase A 実装 + テスト緑 | ここで B/C 並行開始許可 |
| B-完了 | Phase B 実装 + テスト緑 | — |
| C-完了 | Phase C 実装 + テスト緑 | — |
| リリース直前 | npm publish 前 | docs/release-process.md full read |

---

## 2. Phase A — keyboard_type / terminal_send / keyboard_press 自動再ターゲット

### 2.1 新しいパラメータ（3 ツール共通）

```ts
method: z.enum(["auto", "background", "foreground"]).default("auto").describe(
  "Input routing channel. 'auto' picks background (PostMessage) when the target process supports it, " +
  "else foreground (SetForegroundWindow). 'background' forces PostMessage-only (no focus change, " +
  "fails on Chromium/IME). 'foreground' forces the current behavior (focus + keystrokes). Default 'auto'."
)
```

追加する既存ツール:
- `keyboard_type`（`src/tools/keyboard.ts`）
- `keyboard_press`（同）
- `terminal_send`（`src/tools/terminal.ts`）

**後方互換**: `method` 未指定時は `"auto"`。ただし `"auto"` の初期分岐は現行動作（foreground）を継承し、**BG 対応プロセスに対してのみ BG を選ぶ** → 既存テストは全部通る。

### 2.2 BG チャネルの実装場所

**新規ファイル**: `src/engine/bg-input.ts`

配置理由:
- `win32.ts` は koffi バインディング層で既に 900 行超。WM_CHAR 注入は **論理（サロゲートペア分解、VK→scan code、per-HWND 判定）** が重いため独立ファイルが妥当。
- `nutjs.ts` は nut-js ラッパで foreground 前提の責務分離が明確なので、混ぜない。

公開 API（`bg-input.ts` の export）:
```ts
export function postCharsToHwnd(hwnd: bigint | unknown, text: string): { sent: number; full: boolean };
export function postKeyToHwnd(hwnd: bigint | unknown, vk: number, opts?: { withShift?: boolean }): boolean;
export function postKeyComboToHwnd(hwnd: bigint | unknown, combo: string): boolean; // 'ctrl+a' 等
export function canInjectViaPostMessage(hwnd: bigint | unknown): {
  supported: boolean;
  reason?: "chromium" | "ime_composing" | "uwp_sandboxed" | "class_unknown";
  className?: string;
  processName?: string;
};
```

### 2.3 Win32 バインディング追加（`win32.ts`）

以下を `win32.ts` に追加し `export` する:

```ts
const PostMessageW = user32.func(
  "bool __stdcall PostMessageW(void *hWnd, uint32 Msg, uintptr wParam, intptr lParam)"
);
const SendMessageW = user32.func(
  "intptr __stdcall SendMessageW(void *hWnd, uint32 Msg, uintptr wParam, intptr lParam)"
);
const GetFocus = user32.func("intptr __stdcall GetFocus()");
const GetGUIThreadInfo = user32.func(
  "bool __stdcall GetGUIThreadInfo(uint32 idThread, _Inout_ GUITHREADINFO *pgui)"
);
const MapVirtualKeyW = user32.func(
  "uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)"
);
// GUITHREADINFO 構造体定義（hwndFocus を取るため）
```

メッセージ定数:
```ts
const WM_CHAR      = 0x0102;
const WM_UNICHAR   = 0x0109; // Unicode で送りたいとき（Chromium は無視、Win32 ネイティブのみ）
const WM_KEYDOWN   = 0x0100;
const WM_KEYUP     = 0x0101;
const WM_IME_CHAR  = 0x0286;
const UNICODE_NOCHAR = 0xFFFF;
```

**`SendMessage` は使わない**（同期呼出で BG 目的を果たさない + デッドロック危険）。`PostMessageW` を使う。

### 2.4 WM_CHAR 注入の挙動設計

#### 文字入力（`postCharsToHwnd`）
1. **フォーカス子ウィンドウを解決**: 目標はトップレベル HWND だが、テキスト入力はしばしば子コントロールに届く。以下の順で解決:
   - `AttachThreadInput` で一時アタッチ → `GetFocus()` で子 HWND を取得 → デタッチ（既存 `forceSetForegroundWindow` の流用可能なヘルパに切り出し）。
   - 取得できなければトップレベル HWND にそのまま送る（Windows Terminal のような単一 HWND アプリはこれで動く）。
   - **注意**: アタッチは 50ms 未満で終える。長いアタッチは foreground-stealing 副作用を起こす。
2. **文字列を UTF-16 コードユニットに分解**:
   - BMP 内（≤ 0xFFFF）: `PostMessageW(hwnd, WM_CHAR, codeUnit, 0)` を 1 回。
   - サロゲートペア（U+10000 以上）: 上位・下位サロゲートを **連続 2 回** `WM_CHAR` で送る。これは Win32 の標準挙動で、受信側の `TranslateMessage` がペア化する。
   - **CR/LF**: `"\n"` は `WM_CHAR` で `'\r'` (0x0D) に変換してから送る（Windows Terminal / conhost 側は `\r` で改行入力を受け取る）。
3. **`lParam` は 0**（リピートカウント 1・スキャンコードは省略）。BG 注入では lParam に正確なスキャンコードが無くても動く。
4. **返り値**: 送った code unit 数と、途中でプロセス終了などで失敗したら `full:false` を返す。

#### キー押下（`postKeyToHwnd`）
- `WM_KEYDOWN(vk, 0)` → `WM_KEYUP(vk, 0)` の 2 メッセージを PostMessage で送信。
- Shift/Ctrl/Alt 修飾が必要な場合、修飾キー自身の `WM_KEYDOWN` / `WM_KEYUP` でサンドイッチする。ただし **BG モードでの ctrl+v は動かないアプリが多い** → ペースト系コンボは保証しない（§2.8 参照）。
- Enter: `postKeyToHwnd(hwnd, VK_RETURN)` 単独で十分（ターミナルの場合 `WM_CHAR '\r'` でも同等に動くことがほとんど、後述 §4.2）。

### 2.5 `canInjectViaPostMessage` — BG 適合判定

判定順（早期 `supported:false` 返し）:

```
1. className を取得 (getWindowClassName)
   → "Chrome_WidgetWin_*" / "Chrome_RenderWidgetHostHWND" / "MozillaWindowClass" / "CefBrowserWindow"
     → supported:false, reason:"chromium"
   → "ApplicationFrameWindow" / "Windows.UI.Core.CoreWindow" （UWP）
     → supported:false, reason:"uwp_sandboxed"   // PostMessage は届くが AppContainer で落ちるケース多

2. GetGUIThreadInfo で IME 合成中か確認
   → flags に GUI_INMENUMODE/GUI_POPUPMENUMODE/GUI_CARETBLINKING 以外に hwndActive の
     IME composition window（class "IME"）が見えたら reason:"ime_composing"
     ※ 完全検出は難しい。fallback として「composition 中に送ると変換崩壊」を許容し、
       warnings[] で "imeCompositionPossible" を立てるだけでも良い（実装者判断）。

3. processName をチェック
   → "chrome"/"msedge"/"brave"/"firefox"/"opera" → supported:false, reason:"chromium"
   → TERMINAL_PROCESS_RE にマッチ → supported:true（Phase C で最適化）

4. それ以外 → supported:true（WM_CHAR で動く前提、失敗したら呼出側で foreground fallback）
```

**判定結果のキャッシュ**: 同一 HWND への連続呼出を想定し、`Map<hwndStr, {result, tsMs}>` で 3 秒間キャッシュ。process 再起動は `identity-tracker` 側で検出されるため整合性取れる。

### 2.6 keyboard_type の `method:"auto"` 分岐ロジック

`src/tools/keyboard.ts` の `keyboardTypeHandler` 先頭に分岐を挿入:

```
1. effectiveWindowTitle が未指定 → method="auto" でも foreground パスに降格
   （対象不明では BG 判定できない）。

2. effectiveWindowTitle を解決して HWND 取得（既存 focusWindowForKeyboard の前段で探索）

3. method="background" or (method="auto" && canInjectViaPostMessage(hwnd).supported)
   → BG パス:
     a. effectiveClipboard=false 強制（clipboard は前面必須）
     b. replaceAll=true なら postKeyComboToHwnd(hwnd, "ctrl+a") を試行
        → Chromium なら supported:false で弾かれているのでここには来ない
        → 標準 Win32 コントロールは Ctrl+A を受ける
     c. postCharsToHwnd(hwnd, text) 実行
     d. method:"background" で sent < text.length なら
        → fail({code:"BackgroundInputIncomplete", suggest:[固定文], context:{sent, total}})
     e. method:"auto" で失敗 → foreground パスにフォールバック（警告つき）
     f. focusFirst / forceFocus 関連のロジックは完全スキップ（前面化しない）
     g. detectFocusLoss は skip（前面化してないので focus 奪取は起きない前提）
     h. post.focusedWindow は prevFg のまま（windowChanged=false）

4. それ以外 → 現行の foreground パス（変更なし）
```

### 2.7 対応チャネル / 非対応アプリの切り分け

| アプリカテゴリ | className 例 | BG 可否 | 備考 |
|---|---|---|---|
| メモ帳 / 標準 Edit | `Edit` / `Notepad` | ○ | 動作確認の基準 |
| Windows Terminal | `CASCADIA_HOSTING_WINDOW_CLASS` | ○ | Phase C で最適化 |
| conhost / cmd / PowerShell | `ConsoleWindowClass` | ○ | `\r` で改行 |
| WSL / mintty / alacritty | `mintty` / `alacritty` | △ | terminal だが個別テスト要 |
| WinUI3 / WPF | 多様 | ○ 多い | Electron 除く |
| **Chrome / Edge / Brave** | `Chrome_WidgetWin_*` | × | CDP 経由（Phase B） |
| **Electron 系（VS Code / Slack / Discord）** | `Chrome_WidgetWin_*` | × | 同上 |
| **UWP (Store アプリ)** | `ApplicationFrameWindow` | × → △ | フォアグラウンド推奨 |
| Java Swing/AWT | `SunAwtFrame` | △ | 要検証、初版は supported:false 扱い |
| Office 2019+ | `rctrl_renwnd32` 等 | △ | 動くがクセあり |

**方針**: 初版は「**確実に動く箇所だけ supported:true**」。分からないクラスは supported:false にして foreground fallback（`method:"auto"` のユーザーは中断を気にしない）。

### 2.8 日本語・IME・修飾キーの扱い

#### 日本語テキスト
- **UTF-16 で 1 code unit ずつ WM_CHAR** が基本。BMP 内の CJK は問題なし。
- **サロゲートペア**: 絵文字等は `high-surrogate → low-surrogate` の順で 2 回連続 WM_CHAR。間に別メッセージを挟まない。
- **IME 合成を回避**: `WM_CHAR` は IME を経由せず直接文字を届ける。**これが BG 入力の最大のメリット**。Phase A の日本語 IME 下で URL 入力問題が消える。
- `WM_UNICHAR` は Chromium が無視するため使わない（そもそも BG では Chromium 対象外）。

#### 修飾キー付きコンボ（`keyboard_press`）
- `ctrl+a` / `ctrl+c` / `ctrl+s` / `enter` / `escape` / `f1-f12`: BG で動く。
- `alt+f4` / `alt+tab`: ウィンドウマネージャが介入 → BG では不確実 → **`method:"auto"` 時は foreground にフォールバック**。
- `win+*`: 既存の `assertKeyComboSafe` でブロック済み（変更不要）。

#### preferClipboard / use_clipboard との関係
- `preferClipboard=true` + `method:"background"` → **矛盾**。以下のいずれか:
  1. ログで警告 + clipboard 無効化 + BG 文字送信（推奨）
  2. `fail({code:"IncompatibleMethod", suggest:["Set preferClipboard:false for background mode"]})`

  → **推奨 1**: LLM がミス設定したとき「動きつつ警告出す」方が UX 良い。`hints.warnings:["BackgroundClipboardDowngraded"]` を付与。
- `preferClipboard=true` + `method:"auto"` で BG が選ばれた → 同様に警告つきで clipboard 無効化。

### 2.9 detectFocusLoss / post.focusedWindow の整合

現行は「foreground で送って、その後 focus が奪われてないか確認」が detectFocusLoss の責務。BG パスでは:
- `trackFocus=true` でも **何も検出しない**（そもそも foreground 変えてない）。
- `post.focusedWindow` は **prevFg.title をそのまま返す**。
- `post.windowChanged` は `false` 固定。
- `hints.method` に `"background"` / `"foreground"` を付与 → LLM が判別可能。

### 2.10 perception / auto-guard との統合

`_action-guard.ts` の `safe.keyboardTarget` ガードは **foreground を要求** する。BG パスでは foreground を上げないので、以下のどちらか:

1. **BG パスでは auto-guard を特別扱い**: BG で入力する場合、`safe.keyboardTarget` の foreground チェックを スキップし、代わりに `target.identityStable` / `target.exists` のみ評価する。
2. **新しい guard `safe.backgroundInput`**（内部実装のみ、LLM 露出なし）を追加し、BG 経路専用で「HWND 存続・プロセス identity 同一・canInject 結果が supported」をチェックする。

→ **推奨 2**。現行 guard を汚さず、BG 専用の意味を明示できる。`guards.ts` に `safeBackgroundInput` を追加し、BG パスのみで発火。`evaluateGuards` の入力に `actionKind: "keyboardBackground"` を追加（`ActionKind` 型拡張）。

### 2.11 エラー・hints 出力

新しい `code` エントリを `src/tools/_errors.ts` の suggest 辞書に追加:

| code | 固定 suggest 文 |
|---|---|
| `BackgroundInputUnsupported` | `["Target app does not accept background input. Use method:'foreground' or omit.", "Chrome/Edge: use browser_fill_input instead"]` |
| `BackgroundInputIncomplete` | `["Input sent partially. Check context.sent vs context.total.", "Retry with method:'foreground' for full input."]` |
| `BackgroundInputImeConflict` | `["IME composition active on target. Cancel composition or use method:'foreground'."]` |

**重要**: これらの固定文に `context` の値（windowTitle 等）を埋め込まない（CWE-94）。常に `context:{windowTitle, className, sent, total}` を別フィールドで返す。

### 2.12 成功レスポンス shape 変更

既存 `keyboard_type` のレスポンスに以下追加:
```json
{
  "ok": true,
  "typed": 5,
  "method": "background",          // ← 新: "keystroke" / "clipboard" / "clipboard-auto" / "background"
  "channel": "wm_char",            // ← 新: "wm_char" / "nutjs" / "clipboard"
  "foregroundChanged": false,      // ← 新: BG では常に false
  "hints": { "method": "background", "warnings": [...] }
}
```

`method` の既存値に `"background"` を追加するだけで破壊的変更ではない（unit test は `.toMatch` で固定文字列比較の場合のみ修正が要る、全量は contract test で把握可能）。

---

## 3. Phase B — set_element_value のチャネル自動チェーン

### 3.1 チェーン全体像

`setElementValueHandler` の内部が以下の順に試行する（**失敗時は次のチャネルへ**）:

```
1. ValuePattern.SetValue（現行）
2. TextPattern2.InsertTextAtSelection（新規）
3. CDP(browser_fill_input 相当の native setter + InputEvent)（新規、browser 判定時のみ）
4. keyboard_type fallback（method:"background" を優先、失敗したら foreground）
```

**シグネチャは変更しない**（透過的に動作）。ただし新パラメータを opt-in で足す:

```ts
channels: z.array(z.enum(["value", "text2", "cdp", "keyboard"])).optional().describe(
  "Channel preference list. Default ['value','text2','cdp','keyboard'] — first success wins. " +
  "Pass a subset (e.g. ['value','keyboard']) to constrain."
),
forceChannel: z.enum(["value", "text2", "cdp", "keyboard"]).optional().describe(
  "Force a single channel (no fallback). Use for testing or when an app is known to misbehave on other channels."
),
clearExisting: z.boolean().default(true).describe(
  "Clear the field before setting (ctrl+A + Delete equivalent). Default true."
),
```

`channels` / `forceChannel` は opt-in なので後方互換。デフォルトの `undefined` は「全 4 チャネルをデフォルト順で試行」。

### 3.2 各チャネルの実装方針

#### チャネル 1: ValuePattern（現行）
- 変更なし。失敗（pattern 不支持 / SetValue 例外）を **chain 内で catch** して次へ。

#### チャネル 2: TextPattern2.InsertTextAtSelection
- **foreground 不要**（UIA TextPattern2 は UIA プロトコル経由で動く、メッセージ注入ではない）。
- PowerShell スクリプトで実装（`uia-bridge.ts` に `insertTextViaTextPattern2` を追加）:

```powershell
Add-Type -AssemblyName UIAutomationClient
# ... element find ...
$tp2 = $found.GetCurrentPattern([System.Windows.Automation.TextPattern2]::Pattern)
$tp2.InsertTextAtSelection('...text...')
```

- **事前処理**: `clearExisting=true` なら `tp2.DocumentRange.Select()` + `tp2.InsertTextAtSelection('')` で消去（または `ctrl+a` `delete` を BG 経由で）。
- **制限**: TextPattern2 は .NET Framework 4.6+ の AutomationElement に存在。古い Win32 の Edit コントロールは非対応 → chain 内で「pattern 無し」を next に送る。
- **動作確認必要アプリ**: Word / Excel / Outlook / メモ帳 UWP / Notion（Electron なので x） / VS Code（Electron なので x）。

#### チャネル 3: CDP（Chrome/Edge のみ）
- **判定**: UIA から取った element の先祖トップレベル HWND の className が Chromium 系なら CDP チャネルを試行。
- **tabId 未知時の解決**:
  1. CDP に `/json` クエリで現在のタブリストを取得。
  2. `windowTitle` と各タブ `title` を部分一致させ、ベストマッチを選ぶ。
  3. 一致しなければ `activeTab`（top-level response の `active:true`）を使う。
  4. それでもダメなら **このチャネルを skip して next**（CDP 依存はオプショナル）。
- **入力方法**:
  - まず `document.activeElement` が target っぽいか（role/name が近いか）チェック。
  - 近ければ `browser_fill_input` 相当のスクリプトを Runtime.evaluate で実行:
    ```js
    const el = document.activeElement;
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new InputEvent('input', {bubbles:true}));
    ```
  - active でなければ、UIA で取れた element の位置情報から `elementFromPoint` で DOM 要素を取得し、同じ setter 経路で流し込む。
- **React / Vue 制御**: 上記 native setter + InputEvent で ok。contenteditable は:
  ```js
  el.focus();
  document.execCommand('insertText', false, value);
  ```
  の組合せにフォールバック（Lexical / Slate など一部 editor でも insertText は発火する）。
- **fiber walk での onChange 直呼び**: Glama などの特殊ケース（`feedback_react_codemirror.md`）は **chain では追わない**。LLM 側で `forceChannel:"cdp"` の失敗後、明示的に別経路（`browser_eval` で fiber walk）に切り替える方針。

#### チャネル 4: keyboard_type fallback
- `set_element_value` 内部から `keyboardTypeHandler` を呼ぶ（require cycle 回避のため小さな helper `typeFallback(text, windowTitle, method)` を共有化）。
- `method:"auto"` → Phase A の自動判定で BG/FG を選ぶ。
- まず `click_element` 的に要素を focus（UIA `Invoke` or coord click）してから type。
- `clearExisting=true` なら先に ctrl+a / delete を送る。

### 3.3 チェーン失敗時のエラー報告形式

チェーン全試行後も成功しなければ:
```json
{
  "ok": false,
  "code": "SetValueAllChannelsFailed",
  "error": "All set_element_value channels failed",   // 固定文
  "suggest": [                                         // 固定文配列
    "Verify the element supports text input",
    "Try click_element + keyboard_type manually",
    "Check context.attempts for per-channel error codes"
  ],
  "context": {
    "windowTitle": "...",
    "name": "...",
    "attempts": [
      {"channel": "value", "error": "ValuePatternNotSupported"},
      {"channel": "text2", "error": "TextPattern2NotSupported"},
      {"channel": "cdp", "error": "TabNotResolved"},
      {"channel": "keyboard", "error": "BackgroundInputIncomplete"}
    ]
  }
}
```

個別チャネルの失敗詳細は `context.attempts[]` に配列で格納（**可変値を suggest に入れない** 原則）。

### 3.4 既存シグネチャ透過性

- デフォルト動作（`channels`/`forceChannel` 省略）では、**従来 ValuePattern 成功ケースは 1 回の PowerShell 呼出で完了** → レイテンシ退行なし。
- 既存テスト `tests/e2e/ui-elements-cache.test.ts` 等は無改変で通る想定。
- 新チャネルは opt-in フラグで試験できるため、段階的に chain 拡張可能。

### 3.5 auto-guard との関係
- `set_element_value` は既に `actionKind:"uiaSetValue"` で auto-guard。
- キーボード fallback 経路に入ったとき、内部で再度 guard 評価が走ると二重 → **内部呼出フラグ `_internal:true`** を `typeFallback` に渡し、internal 呼出は guard 評価をスキップする。

---

## 4. Phase C — terminal_send 専用 BG チャネル最適化

### 4.1 method:"auto" 時のターミナル優先

`terminal_send` は、Phase A の汎用 BG ロジックに加えて以下の最適化を入れる:

```
1. findTerminalWindow で HWND 解決（既存）
2. getWindowClassName(hwnd) + getProcessIdentityByPid(pid).processName を取得
3. 以下のどれかなら method:"auto" → BG 強制（SetForegroundWindow を呼ばない）
   - TERMINAL_PROCESS_RE にマッチ（既存正規表現）
   - className が ConsoleWindowClass / CASCADIA_HOSTING_WINDOW_CLASS
4. それ以外（タイトルが "PowerShell" でもプロセスがブラウザ等の偽装）→ Phase A の汎用判定に委譲
```

### 4.2 Windows Terminal (WT) vs conhost の違い

| 項目 | WT (`CASCADIA_HOSTING_WINDOW_CLASS`) | conhost (`ConsoleWindowClass`) |
|---|---|---|
| WM_CHAR への文字入力 | ○ 動く | ○ 動く |
| WM_CHAR `'\r'` で改行実行 | ○ 動く | ○ 動く |
| `WM_KEYDOWN VK_RETURN` | ○ 動く（冗長） | ○ 動く |
| `AttachThreadInput` + `GetFocus()` で子 HWND | WT はペイン分割してるので必要 | conhost は単一 HWND で不要 |
| Ctrl+C シグナル送信（中断） | BG では効かない → `GenerateConsoleCtrlEvent` で対応（別途） | 同上 |

**改行の統一仕様（実装上）**:
- `pressEnter=true` → **`WM_CHAR(0x0D)` 単独送信**（WT/conhost/cmd/PowerShell 全てで動く、最少メッセージ）。
- ただし input 末尾に既に `\r\n` / `\n` が含まれていた場合は pressEnter を追加しない（二重改行防止）。現行 terminal_send はこの重複チェックをしていないので Phase C で追加する。

### 4.3 focusFirst / restoreFocus の統合

```
既存 terminal_send の focusFirst=true / restoreFocus=true のデフォルトはそのまま
method:"background" の場合:
  - focusFirst → 無視（warnings:["BackgroundIgnoresFocusFirst"]）
  - restoreFocus → 無視（BG では前面化しないので復元不要）
  - trackFocus → 無視（前面化してないので focusLost 発生しない）

method:"auto" で BG が選ばれた場合:
  - 同上（focusFirst/restoreFocus/trackFocus は事実上無効化、warnings で通知）

method:"foreground":
  - 現行動作（focusFirst/restoreFocus/trackFocus が全て機能する）
```

### 4.4 preferClipboard との関係

- `preferClipboard=true` + BG モード → **clipboard 経路は使えない**（Ctrl+V がターミナルに届いても foreground 無しでは貼付されないアプリもある）。`hints.warnings:["BackgroundClipboardDowngraded"]` + BG 文字送信に降格。
- CJK テキスト: Phase A の WM_CHAR Unicode code unit 経路で OK（IME を経由しない）。
- 長文（10000 文字）: BG では 1 文字ずつ PostMessage が大量発生 → ラッシュでアプリ側キューが飽和する懸念。**PostMessage を 100 文字ごとに `setImmediate` で分割する**（or `setTimeout(0)`）。実測で調整。

### 4.5 pressEnter の BG 実装

```ts
// 現行：
await keyboard.pressKey(...parseKeys("enter"));
await keyboard.releaseKey(...parseKeys("enter"));

// BG パス：
postCharsToHwnd(targetHwnd, "\r");  // WM_CHAR 0x0D
// または
postKeyToHwnd(targetHwnd, VK_RETURN);  // WM_KEYDOWN/UP
```

**推奨**: `WM_CHAR '\r'` のみ。これで WT/conhost/cmd/PowerShell/WSL 全て OK と確認されている（実装時に個別検証必要）。

### 4.6 terminal_send 固有の新パラメータ

Phase A 共通の `method` に加え、以下を optional で追加:
```ts
chunkSize: z.number().int().min(1).max(10000).default(100).describe(
  "Split long input into chunks of this many characters, yielding between chunks (prevents terminal input queue saturation). Default 100. Only applies to background mode."
),
```

---

## 5. 共通考慮事項

### 5.1 後方互換

| 観点 | 保証内容 |
|---|---|
| `keyboard_type({text:"x"})` | 現行動作（foreground + keystrokes） |
| `keyboard_type({text:"x", windowTitle:"Notepad"})` | `DTM_BG_AUTO=0`（デフォルト）では現行動作。`DTM_BG_AUTO=1` または `method:"background"` 明示時のみ BG 動作 |
| `set_element_value({...})` | `DTM_SET_VALUE_CHAIN=0`（デフォルト）では ValuePattern 単段の従来動作。chain は `DTM_SET_VALUE_CHAIN=1` 時のみ有効 |
| `terminal_send({windowTitle:"...", input:"..."})` | `DTM_BG_AUTO=0`（デフォルト）では既存 clipboard 経路が現行通り動く |

**Feature flag ロールアウト（v0.14.0 同梱、flag で段階制御）**:
- v0.14.0: スキーマに `method` / `chunkSize` 追加。A+B+C のコードは全て同梱。ただし `DTM_BG_AUTO=0` / `DTM_SET_VALUE_CHAIN=0` のデフォルトで従来動作。
- v0.14.1: `DTM_BG_AUTO` デフォルトを 1 に変更（BG 自動選択が既定に）。
- v0.14.2: `DTM_SET_VALUE_CHAIN` デフォルトを 1 に変更（チェーン拡張が既定に）。

**Phase B v0.14.0 の縮小スコープ**:
- ValuePattern + keyboard fallback の 2 チャネルを実装（テスト緑必須）。
- TextPattern2 / CDP チャネルはコード同梱だが `DTM_SET_VALUE_CHAIN=0` では skip。
- Office（winword / excel / outlook / powerpnt）は v0.14.0 で explicit skip 固定。

### 5.2 テスト方針

新規テストファイル:
- `tests/unit/bg-input.test.ts` — `postCharsToHwnd` / `postKeyToHwnd` のモック（koffi をスタブ）。サロゲートペア、`\n→\r` 変換、修飾キーシーケンスの組立検証。
- `tests/unit/can-inject.test.ts` — `canInjectViaPostMessage` の className/processName 判定表。
- `tests/e2e/background-input.test.ts` — メモ帳を backend で開き、foreground に別ウィンドウを置いた状態で `keyboard_type({method:"background", ...})` し、`terminal_read` 相当で内容確認。
- `tests/e2e/terminal-bg.test.ts` — WT / conhost を開き BG 送信、foreground を変えずに `terminal_read` で echo 確認。
- `tests/e2e/set-element-value-chain.test.ts` — ValuePattern 失敗→TextPattern2 成功のモックチェーン、CDP チャネルの tabId 解決失敗→keyboard fallback の分岐網羅。

既存テストへの影響:
- `keyboard-focus-lost.test.ts` は `method:"foreground"` を明示して現行動作を固定。
- `terminal.test.ts` は `method:"foreground"` を明示（既存挙動維持の確認）。

**テスト実行指針（CLAUDE.md 準拠）**:
- `npm run test:capture > .vitest-out.txt` で 1 回取得。
- テスト失敗時は **コードを書き換える前に Opus 相談**（強制命令 4）。

### 5.3 Opus 再レビューポイント

以下の Phase 境界で Opus レビュー必須:

1. **Phase A 設計完了（本ドキュメント）** — 概念設計 × プラン × スキーマ追加の 3 者一致確認。
2. **Phase A 実装完了** — `bg-input.ts` 公開 API、`canInjectViaPostMessage` 判定表の正当性、日本語サロゲートペアの挙動、auto-guard 統合（`safe.backgroundInput` 新設）。
3. **Phase B chain 実装完了** — チャネル順序、失敗カスケード、`context.attempts[]` 構造、CDP tabId フォールバック。
4. **Phase C WT/conhost 実装完了** — `WM_CHAR '\r'` のみで 4 シェル（cmd/PS/pwsh/WSL）と WT/conhost 5 環境で全部動くかの実測ログ。
5. **リリース直前** — `docs/release-process.md` full read + npm publish 前。

### 5.4 perception / identity-tracker との連動

- BG パスでも `observeTarget(windowTitle, hwnd, title)` は呼ぶ（identity スナップショットを更新）。
- `hints.target.*` は従来通り埋まる。
- `post.perception` は `buildEnvelopeFor` がそのまま使える（foreground=false でも lens 側は正しい）。
- **AutoGuard の `safe.keyboardTarget` は BG パスでは評価しない**（代わりに `safe.backgroundInput` を評価）。ActionKind を `"keyboardBackground"` として区別。

### 5.5 セキュリティ

- **CWE-94 防止**: 新規 error 定数群（`BackgroundInputUnsupported` 等）は固定文のみ。ユーザー入力は `context.*` に分離。
- **win+** コンボは既存 `assertKeyComboSafe` でブロック（BG パスでも同じガード）。
- **BG で他人のウィンドウに入力** のリスク: PostMessage はウィンドウを持ってる相手にしか届かない + 同一セッション内では防ぐ仕組みは Windows 側に元々無いので、AutoGuard 側で「identity が registration 時と異なれば block」を担保する。

---

## 6. 未解決の設計判断（実装時に Sonnet が判断）

以下は設計書で方針を複数提示したが実装時に最終判断が要るもの。**判断が割れたら Opus に委譲**（強制命令 4）。

### 6.1 `method:"auto"` の初期挙動
- **選択肢 A**: 初版から `canInjectViaPostMessage` で BG 自動選択。
- **選択肢 B**: 初版は `"auto"=foreground` エイリアス。次版で実 BG に切替。
- **推奨**: **B**（保守的ロールアウト）。リグレッション切り分けが容易。

### 6.2 `WM_CHAR` vs `WM_UNICHAR` の選択
- **選択肢 A**: BMP は WM_CHAR、サロゲートペアは WM_CHAR × 2 回。
- **選択肢 B**: すべて WM_UNICHAR で送る（Chromium 非対応でも対象外なので無関係）。
- **推奨**: **A**（標準的実装、受信側互換が広い）。B は受付けないアプリがあり得る。

### 6.3 IME 合成検出の精度
- **選択肢 A**: `GetGUIThreadInfo` + class "IME" 厳密検出。
- **選択肢 B**: 検出せず、warnings で "imeCompositionPossible" を常に付与。
- **推奨**: **B**（検出精度を上げるコストが見合わない、WM_CHAR は IME をそもそも経由しないので実害少）。

### 6.4 BG 失敗時の auto fallback 挙動
- `method:"auto"` で BG 試行 → `postCharsToHwnd` 途中失敗
- **選択肢 A**: 残りを foreground で投げ直す（混在）。
- **選択肢 B**: 全部 fail として報告し、LLM に `method:"foreground"` 再実行を促す。
- **推奨**: **B**（半送り状態は最悪の UX、送信アトミック性を保つ）。

### 6.5 Phase B の CDP tabId 解決失敗時
- **選択肢 A**: keyboard fallback に落ちる（現行の「UIA コントロールを UIA → keyboard で入力」に近い）。
- **選択肢 B**: `fail({code:"CdpTabUnresolved", ...})` で即エラー返す。
- **推奨**: **A**（チェーンの目的は最終的に動くこと。tabId 失敗でも keyboard が動けば成功）。

### 6.6 Phase B で TextPattern2 が Word/Excel に動かない場合
- 実測で **Office が TextPattern2 を正しく返さない / カーソル位置がずれる** 場合、初版では skip 条件を広めに取るか、それとも chain に残すか。
- **実装時に必ず実測**（Notepad / WordPad / Word / Excel / Outlook の 5 本）。
- **推奨**: Office 系は `processName` が "winword"/"excel"/"outlook" のとき TextPattern2 を skip（chain 3 番目の CDP も skip、keyboard fallback 直行）。

### 6.7 長文 BG 入力の chunk サイズ
- WT のキュー飽和実測で `100 / 50 / 200` のどれが最適か要確認。
- **実装時に 3 値で実測比較**し、最も速く取りこぼしない値をデフォルトに。

### 6.8 set_element_value の `channels` パラメータを公開するか
- **選択肢 A**: 公開する（LLM が forceChannel:"cdp" 等で制御可能）。
- **選択肢 B**: 公開せず、内部固定チェーンのみ（LLM への負担減）。
- **推奨**: **B で初版リリース → 実運用で「特定チャネル強制したい」要望が出たら公開**。道具箱は小さい方が良い（56 ツールを増やさない精神と一致）。

---

## 7. 修正・追加ファイル一覧

| ファイル | 変更 |
|---|---|
| `src/engine/bg-input.ts` (**新規**) | `postCharsToHwnd` / `postKeyToHwnd` / `postKeyComboToHwnd` / `canInjectViaPostMessage` |
| `src/engine/win32.ts` | `PostMessageW` / `GetFocus` / `GetGUIThreadInfo` / `MapVirtualKeyW` 追加 |
| `src/engine/perception/guards.ts` | `safeBackgroundInput` guard 追加 |
| `src/engine/perception/types.ts` | `ActionKind` に `"keyboardBackground"` 追加 |
| `src/tools/keyboard.ts` | `method` パラメータ、BG パス分岐、`method` フィールドをレスポンスに追加 |
| `src/tools/terminal.ts` | `method` / `chunkSize` パラメータ、BG パス分岐、改行重複ガード |
| `src/tools/ui-elements.ts` | `setElementValueHandler` をチェーン化（Phase B） |
| `src/engine/uia-bridge.ts` | `insertTextViaTextPattern2` 追加（Phase B） |
| `src/tools/_errors.ts` | `BackgroundInputUnsupported` / `BackgroundInputIncomplete` / `BackgroundInputImeConflict` / `SetValueAllChannelsFailed` 固定 suggest 追加 |
| `src/tools/_action-guard.ts` | `actionKind:"keyboardBackground"` ブランチ |
| `tests/unit/bg-input.test.ts` (**新規**) | サロゲートペア / 改行 / 修飾キー unit test |
| `tests/unit/can-inject.test.ts` (**新規**) | className / processName 判定表 |
| `tests/e2e/background-input.test.ts` (**新規**) | Notepad BG 入力 E2E |
| `tests/e2e/terminal-bg.test.ts` (**新規**) | WT / conhost BG 送信 E2E |
| `tests/e2e/set-element-value-chain.test.ts` (**新規**) | chain 分岐網羅 E2E |
| `docs/system-overview.md` | Keyboard / Terminal / UI Automation セクションに `method` パラメータと BG チャネル説明を追記 |
| `src/index.ts` | LLM instruction text の keyboard_type / terminal_send の説明を更新（BG 活用パターン追記） |

---

## 8. v0.14.0 統合 checklist（実装担当が flip）

### Phase A（先行、B/C の土台）
- [ ] `win32.ts` に PostMessageW / GetFocus / GetGUIThreadInfo / MapVirtualKeyW バインディング追加
- [ ] `bg-input.ts` 新規作成、4 公開 API 実装
- [ ] Notepad で `keyboard_type({method:"background", windowTitle:"Notepad", text:"テスト"})` が foreground 変えずに動く
- [ ] Chrome で `method:"background"` が `BackgroundInputUnsupported` を返す
- [ ] 日本語（漢字・絵文字＝サロゲートペア）を含むテキストで正しく入力
- [ ] `DTM_BG_AUTO=0`（デフォルト）で `method:"auto"` が現行 foreground 動作と同一
- [ ] `safe.backgroundInput` guard が `safe.keyboardTarget` と独立に評価
- [ ] unit test (`bg-input.test.ts` / `can-inject.test.ts`) + E2E (`background-input.test.ts`) 緑
- [ ] **【A 境界 Opus レビュー指摘 0 件 → B/C 並行開始許可】**

### Phase C（A 完了後着手）
- [ ] `terminal_send` の `method:"auto"` + `DTM_BG_AUTO=1` で TERMINAL_PROCESS_RE にマッチする窓では BG を選ぶ
- [ ] WT / conhost の 2 環境で BG 送信動作確認（cmd / pwsh / WSL は `DTM_BG_AUTO=1` 時の動作を `hints.warnings` で「未検証」として返す）
- [ ] `pressEnter=true` が `WM_CHAR '\r'` 単独で WT / conhost 両環境で改行実行されることを実測
- [ ] `chunkSize:100` で 10000 文字 BG 送信が取りこぼしなし
- [ ] `preferClipboard=true` + BG モードの降格警告（`hints.warnings:["BackgroundClipboardDowngraded"]`）が出る
- [ ] E2E (`terminal-bg.test.ts`) 緑
- [ ] **【C 境界 Opus レビュー指摘 0 件】**

### Phase B（A 完了後 C と並行着手）
- [ ] `setElementValueHandler` チェーン化、`context.attempts[]` 構造固定
- [ ] ValuePattern + keyboard fallback の 2 チャネルで Notepad / WordPad 動作確認（`DTM_SET_VALUE_CHAIN=0` デフォルト）
- [ ] `DTM_SET_VALUE_CHAIN=1` 時のみ TextPattern2 / CDP チャネルが有効化される
- [ ] `insertTextViaTextPattern2` PowerShell 実装（Notepad / WordPad の 2 環境のみ v0.14.0 必須）
- [ ] Office（winword / excel / outlook / powerpnt）は TextPattern2 を explicit skip 固定
- [ ] CDP チャネルは `DTM_SET_VALUE_CHAIN=1` + Chromium 系 のみで発動、tabId 未解決時は keyboard fallback
- [ ] チェーン失敗時の `SetValueAllChannelsFailed` エラー shape 確認
- [ ] 現行 ValuePattern 成功ケースで性能退行なし（`DTM_SET_VALUE_CHAIN=0` 時は単発チャネルで終了）
- [ ] E2E (`set-element-value-chain.test.ts`) 緑（`DTM_SET_VALUE_CHAIN=0` ケースが CI デフォルト対象）
- [ ] **【B 境界 Opus レビュー指摘 0 件】**

### リリース統合
- [ ] `DTM_BG_AUTO=0` / `DTM_SET_VALUE_CHAIN=0` のデフォルトで contract test 全緑（56 ツール数不変 / 後方互換）
- [ ] `DTM_BG_AUTO=1` / `DTM_SET_VALUE_CHAIN=1` で smoke test 緑
- [ ] `npm run generate:stub-catalog` 実行済み
- [ ] `docs/system-overview.md` 更新
- [ ] `src/index.ts` LLM instruction 更新（`method` パラメータと BG 活用パターン追記）
- [ ] `docs/release-process.md` full read
- [ ] **【リリース直前 Opus レビュー指摘 0 件】**
- [ ] v0.14.0 リリース（A + B + C 一括 ship、feature flag でデフォルト無効）

---

## 9. 参照

- `docs/terminal-integration-plan.md` — 既存 terminal_send / terminal_read の設計土台
- `docs/anti-fukuwarai-ideals-plan.md` — envelope / hints / identity tracker 語彙
- `docs/reactive-perception-graph.md` — perception / auto-guard
- `feedback_codeql_suggest_strings.md` — CWE-94 回避原則（suggest は固定文、可変値は context）
- `feedback_react_codemirror.md` — React 制御フォームの fiber walk（Phase B の chain 対象外、LLM 側で対応）
- Microsoft Docs: [PostMessageW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postmessagew) / [WM_CHAR](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-char) / [TextPattern2.InsertTextAtSelection](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.textpattern2.inserttextatselection)
