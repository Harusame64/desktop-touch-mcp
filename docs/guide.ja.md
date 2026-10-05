# desktop-touch-mcp ガイド

[English](guide.md) · [README に戻る](../README.ja.md)

[README](../README.ja.md) に載せきれない詳細です。拒否ごとの戻り方、各機能、設定と診断。インストール、ツール一覧、推奨ワークフローは README を先に読んでください。

## 目次

- [リカバリと lease](#リカバリと-lease)
- [ターミナルの完了判定 (`until`)](#ターミナルの完了判定-until)
- [Key Locker (ターミナル認証情報の自動入力)](#key-locker-ターミナル認証情報の自動入力)
- [ブラウザ CDP 自動化](#ブラウザ-cdp-自動化)
- [マウスホーミング補正（トラクションコントロール）](#マウスホーミング補正トラクションコントロール)
- [screenshot の主要パラメータ](#screenshot-の主要パラメータ)
- [セキュリティ](#セキュリティ)
- [マウス移動速度](#マウス移動速度)
- [Force-Focus (AttachThreadInput)](#force-focus-attachthreadinput)
- [UI オペレーティングレイヤー (V2)](#ui-オペレーティングレイヤー-v2)
- [ネイティブエンジンの性能（v0.15 時点の計測）](#ネイティブエンジンの性能v015-時点の計測)
- [パフォーマンス目安](#パフォーマンス目安)
- [Claude へのシステムプロンプト（自動注入）](#claude-へのシステムプロンプト自動注入)
- [`workspace_launch` 起動許可リスト](#workspace_launch-起動許可リスト)

---

## リカバリと lease

リカバリ — `response.attention` を毎観測でチェック、`desktop_discover` / `desktop_act` の `response.warnings[]` を読む:

- `lease_expired` / `lease_generation_mismatch` / `lease_digest_mismatch` / `entity_not_found` → `desktop_discover` を再実行
- `modal_blocking` → `response.blockingElement` (含まれていれば) がブロック中の modal を識別する。`role: "dialog"` は、別のダイアログ窓が対象の窓を無効にしていることを表す。`blockingElement.hwnd` がそのダイアログなので、`target.hwnd = blockingElement.hwnd` で `desktop_discover` し直して答えてからリトライ（`name` は題名で、空や他と同じことがある）。それ以外の role は、`desktop_discover` のスナップショットに写っている窓で、この entity を塞いでいるかを OS が答えられなかったもの。`blockingElement.hwnd` があれば `target.hwnd = blockingElement.hwnd` で `desktop_discover` し直して答え、無ければ `click_element(name=blockingElement.name)` で閉じる。そのあと元の対象を `desktop_discover` し直し、新しい lease で撃つ（この拒否はそのスナップショットから出たので、同じ lease では再び拒まれる）
- `entity_outside_viewport` → 要素が画面外へ移動: `scroll(action='to_element' | 'raw')` 後に `desktop_discover` 再実行（窓ごと移動・閉じた場合は再 discover）
- `origin_window_not_visible` → 要素の由来ウィンドウが最小化 / 非表示で、発見時の座標には何も描画されていない: `focus_window(windowTitle)` で復元してから `desktop_discover` 再実行
- `coordinate_outside_reachable_bounds` → 座標がどのモニタ上にも無い。座標ベースのマウス入力（`mouse_click` / `mouse_drag` / `scroll` / `browser_click`、および `desktop_act` の mouse route）は**全モニタで動作する**ようになった（プライマリの左 / 上に置いたモニタを含む）ため、このエラーは通常「座標が古い」ことを意味する — 読み取った後にウィンドウが移動 / 閉じた場合。`desktop_discover` を再実行して新しい座標で操作する。サーバが内蔵の Windows 入力モジュール無しで動いている場合はプライマリモニタのみに fallback する（その旨がエラーメッセージに出る）。対処はウィンドウをプライマリへ移すか、サーバの再インストール
- `cursor_placement_blocked` → 座標はモニタ上にあるが、ポインタをそこへ置けなかったためクリックは送られていない。他のアプリがカーソルを自分のウィンドウ内に拘束している（全画面ゲームで多い）/ リモートデスクトップのセッションが切断・ロックされている / 他のプログラムがポインタを動かし続けている / モニタを着脱した直後、といった場合に起きる。カーソルを掴んでいるアプリから離れる、セッションに再接続する、モニタ構成を変えた場合は `desktop_discover` を取り直してから再試行する。カーソルを動かさない `click_element`（UIA invoke）はその間も使える
- `keyboard_target_unsafe` → 文字が指定した欄に届かないため `type` を拒否した。キーボードのフォーカスが別のコントロールか別のウィンドウにある、受け取るコントロールか指定した欄が読み取り専用、または指定した欄（かそのウィンドウ）が無効。何も入力されておらず、どれかは `if_unexpected.detail` に出る。無効なら、無効にしているもの（送信中のフォーム・ダイアログ・まだ済んでいない手順）が済むのを待つか答えてから、`desktop_discover` し直して入力し直す。クリックしても変わらない。`desktop_discover` は無効な欄を出さないので、そこに出ないあいだはまだ無効。指定した欄が読み取り専用なら、その欄は文字を受け付けないので、打ち直しても変わらない。別のコントロール / ウィンドウなら、指定した欄にフォーカスを移してから入力し直す。その道ごとの戻り方は `if_unexpected.detail` に出る。タイトルで指定したウィンドウなら同じ entity への `desktop_act`（`action='click'`）で移せる。ハンドルで指定したウィンドウでは、テキスト欄へフォーカスを移す道がまだ無いので、ウィンドウのタイトルで `desktop_discover` し直し、そこから欄をクリックする——ただし共通ダイアログ（名前を付けて保存・開く）はタイトルもハンドルに解決するので、その道は開かない。別のウィンドウのときは、まず欄のウィンドウを前面に出す（`focus_window`）: 最後に持っていたフォーカスのまま前へ出るうえ、フォーカスを持っているウィンドウはたいてい欄の上に描かれている。前面の `keyboard` で打ち直さないこと: フォーカスを持っているものが文字を受け取ってしまう
- `executor_failed` → `if_unexpected.detail` が "Nothing was typed" で始まるときは、どの経路も走っておらず何も入力されていない — detail のとおりにする。それ以外は desktop_act が取った経路が失敗した。クリックなら V1（`click_element` / `mouse_click` / `browser_click`）に、入力なら欄にフォーカスして `keyboard(action='type', method='foreground')` にフォールバック

成功した `type` に `landing: { confirmed: false, why }` が付くことがある。書き込みは背景の経路を通ったが、指定した欄に届いたことをサーバが確かめられなかった（例: WPF のウィンドウは欄ごとのウィンドウを持たない）。**これは報告であり、ここで解消できる状態ではない**——応答の中に文字が届いたかを示すものは無く、欄を読み返しても決着しない（`desktop_state` は前面について答え、値を一切返さないことも、同じ題の別の窓の欄を名乗ることもある。`hints.focusedElementValueAbsent` は落とした road を名乗る——`view_road_has_no_value` か `masked_on_this_road`。**hint が無いことは値が在った証拠ではない**）。`diff.value_changed` も配達ではない——その基準は書き込みではなく `desktop_discover` のスナップショットである。そして**空でない書き込みの再試行は反復ではない**——背景の書き込みは打鍵と同じくキャレット位置に入り、選択を置換する。

Lease ライフサイクル:

- `desktop_discover` のレスポンスに `softExpiresAtMs` (TTL の約 60%) が含まれます。これを過ぎたら lease 自体は valid でも proactive に `desktop_discover` を再実行することを推奨。`lease.expiresAtMs` だけが本当の correctness 境界です。
- TTL は `view` モード (`action`/`explore`/`debug`)、entity 数、レスポンスサイズに応じて伸縮 (上限 60 秒)。
- `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` で V1 ツール (`get_windows` / `get_ui_elements` / `set_element_value`) にフォールバック可能 — トラブルシューティング目的のみ。標準は V2。

### Reactive Perception Graph (4)
| ツール | 概要 |
|---|---|
| `perception_register` | 対象ウィンドウ/タブの live perception lens を登録し、action tool に渡す `lensId` を返す |
| `perception_read` | attention が dirty/stale/blocked の時に lens を強制更新し、perception envelope を返す |
| `perception_forget` | ワークフロー完了時や対象が置き換わった時に lens を解除 |
| `perception_list` | 登録中 lens を一覧し、再利用やクリーンアップに使う |

Reactive Perception Graph は desktop-touch の低コストな状況把握レイヤーです。対象の同一性・フォーカス・矩形・準備状態・guard 結果を操作間で維持し、Claude が小さな操作のたびにスクリーンショットで確認し直さなくて済むようにします。

---

## ターミナルの完了判定 (`until`)

`terminal(action='run')` はコマンド送信 → 完了待ち → 出力取得を 1 コールで行います。「完了」の判定方法は `until` で選びます:

| モード | 待つ対象 | 用途 |
|---|---|---|
| `quiet`（既定） | 出力が `quietMs` 静かになるまで | 短い対話コマンド |
| `pattern` | 出力に現れる文字列/正規表現 | 最終マーカーが分かる長時間コマンド |
| `exit` | コマンドの**終了そのもの** | 完了や exit code が必要なとき |

> **アンカーの注意 (#384):** 最終行が改行で終わらない出力は、マーカーが次プロンプトに密着して行境界が無くなります（`printf X` → `Xuser@host:~$`）。よって行末アンカー付き `pattern`（`X\s*\n` / `X$`）は**バインド不能**です。**完了検出は `mode:'exit'`**、content マッチは**裸マーカー**（`\n`/`$` を付けない）を使ってください。`mode:'pattern'` には opt-in の `quietMs` settle fallback もあります: `until:{mode:'pattern', pattern, quietMs:1000}` は、pattern 未一致でも出力が指定 ms 安定したら `reason:'quiet'`（`matchedPattern` なし）で完了し、`timeoutMs` までのハングを防ぎます。opt-in（未指定なら pattern を待ち続ける＝silent gap のある長時間コマンドは無影響）。

### `until:{mode:'exit'}` — 本当の完了 + exit code

ヒューリスティックなモードは「センチネルを末尾に付ける」定番（`some-task; echo DONE` を `DONE` で待つ）で誤判定しがちです。センチネルは**エコーされたコマンド行**にも現れ、複数行コマンドではそのエコーと実出力をバッファだけから区別できません。`mode:'exit'` はこれを構造的に解決します — サーバが**表示形と入力形が異なる**完了マーカーをコマンド末尾に注入するため、エコーには決して一致せず（複数行入力でも）、実際のプロセス exit code を返します:

```js
terminal({
  action: 'run',
  windowTitle: 'pwsh',
  input: 'npm run build',
  until: { mode: 'exit', shell: 'powershell' },
})
// → completion: { reason: 'exited', exitCode: 0, elapsedMs: … }
//   output: 注入マーカーは除去され、コマンドの実出力のみ
```

- **`shell` は明示指定推奨**（`'bash'` / `'powershell'`）。`shell:'auto'` はターミナル窓のプロセスから判定しますが、SSH / WSL の**中で**動く shell は見えません（窓はローカルホストのまま）。リモート/ネストしたセッションではリモート側の shell を渡してください（`auto` は警告を出し外側の shell を選ぶ場合があります）。プロセスを真に特定できない窓（Windows Terminal 等）は `ExitModeShellAmbiguous` を返します。
- **first-class shell:** `bash` と `powershell`。`cmd.exe` は未対応（`ExitModeShellUnsupported`）。
- **未完の構文で終わる入力は即座に reject**（`ExitModeUnsafeInput`）。閉じていない引用符 / here-doc / `$(…)` / 末尾の `\` または PowerShell バッククォートなどはハングせず弾きます。
- exit mode は配送を自前制御するため、配送系の `sendOptions`（`method` / `preferClipboard` / `pressEnter` / `chunkSize` / `pasteKey`）は `InvalidArgs` で reject します（focus 系オプションは利用可）。

---

## Key Locker (ターミナル認証情報の自動入力)

`ssh user@host` や `sudo …` は通常、アシスタントが安全に入力できない「隠しパスワードプロンプト」で止まります。Key Locker は SSH 鍵のパスフレーズや sudo / ログインパスワードをこの PC 上に暗号化保存し（Windows DPAPI, current user）、対象コマンドがプロンプトに達すると自動で入力します。秘密情報の入力はロッカー自身のセキュアダイアログへの一度きり — アシスタントには一切見えず、MCP チャネルを通ることもありません。

```js
// 1. 認証情報を一度だけ登録 — デスクトップにセキュアダイアログが開く
key_locker({ action:'save', uri:'ssh://user@host:22' })

// 2. 自動入力対応コンソールを起動（paneId が返る）
key_locker({ action:'launch_console' })   // → { paneId:'12345678', windowTitle:'…' }

// 3. その pane にコマンドを流す — プロンプトでパスワードが自動入力される
terminal({ action:'send', paneId:'12345678', input:'ssh user@host' })
```

- **自動入力は `launch_console` で開いたコンソールでのみ発火** — 既存のターミナルには決して入力しません。開くのは通常の可視な Windows コンソールなので、目視でき、任意のプロンプトで人間が引き継いで直接入力もできます。
- **既定では自動入力の度に確認ダイアログ**が出ます。binding 単位で `set_policy` により確認を省略可。保存済み認証情報の管理は `list` / `status` / `forget`。
- `terminal` の `read` / `send` は `windowTitle` の代わりに `paneId` を受け取れます — `ssh` ログインでウィンドウタイトルが変わっても同じ窓を正確に狙えます。
- 対応 binding URI: `ssh://user@host:22`、`sudo://host/user`、`https-cred://host`、SSH 鍵パスフレーズ（`sshkey:SHA256:…`）。`ssh` の登録はホスト鍵が `known_hosts` にあることが前提です（先に一度手動で接続してください）。
- Windows 専用。機能全体の無効化は `DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1`。セキュアダイアログは未署名の実行ファイルのため、初回起動時に Windows SmartScreen の「発行元不明」警告が出ることがあります（[前提環境](../README.ja.md#前提環境)の注意参照）。

---

## ブラウザ CDP 自動化

Chrome/Edge をリモートデバッグポート付きで起動するだけで、DOM 要素をピクセル精度でクリックできます。

```bash
# Chrome を CDP モードで起動
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp
```

```
browser_open({launch:{}})                                → 必要時 spawn してから接続（idempotent）
browser_open()                                           → 純 connect（CDP 未起動なら fail）
browser_locate({selector:"#submit"})                     → CSS セレクター → 物理ピクセル座標
browser_click({selector:"#submit"})                      → 検索 + クリックを 1 ステップで
browser_eval({action:"js", expression:"document.title"}) → JS 評価して結果を返す
browser_eval({action:"dom", selector:"#main", maxLength:5000})  → outerHTML を取得（文字数制限付き）
browser_eval({action:"appState"})                        → SPA ステートを 1 呼び出しで抽出（Next/Nuxt/Remix/Apollo/GitHub/Redux SSR）
browser_overview()                                       → リンク/ボタン/入力 + ARIA トグル (state.checked 等) を列挙
browser_search({by:"text", pattern:"..."})               → DOM を grep（confidence 順）
browser_navigate({url:"https://example.com"})            → CDP 経由でページ遷移
```

同一タブで連続呼び出しする場合は `includeContext:false` で末尾の activeTab/readyState 行を省略可（~150 tok/call 削減）。boolean / object パラメータは LLM が string 化した値（`"true"` / `"{}"`）でも受け付けます。

`browser_locate` が返す座標はブラウザUI（タブストリップ + アドレスバー）の高さと `devicePixelRatio` を考慮済みなので、`mouse_click` にそのまま渡せます。

**Web 操作の推奨フロー:**
```
browser_open({launch:{}}) → browser_eval({action:"dom"}) → browser_locate(selector) → browser_click(selector)
```

---

## マウスホーミング補正（トラクションコントロール）

Claude が `screenshot(detail='text')` で座標を取得してから `mouse_click` を呼ぶまでの数秒間に、ウィンドウが移動・裏に隠れることがある「福笑い問題」を MCP サーバー側で自動補正します。

| Tier | 有効化方法 | レイテンシ | 効果 |
|------|-----------|-----------|------|
| 1 | 常時（cache あれば） | <1ms | ウィンドウ移動を (dx, dy) 補正 |
| 2 | `windowTitle` ヒントを指定 | ~100ms | 裏に隠れたウィンドウを自動前面化 |
| 3 | `elementName`/`elementId` + `windowTitle` | 1–3s | リサイズ時に UIA で最新座標を再クエリ |

```
# Tier 1 のみ（自動）
mouse_click(x=500, y=300)

# Tier 1 + 2: 裏に隠れていても前面化してクリック
mouse_click(x=500, y=300, windowTitle="メモ帳")

# Tier 1 + 2 + 3: リサイズ時も UIA で再クエリ
mouse_click(x=500, y=300, windowTitle="メモ帳", elementName="保存")

# トラクションコントロール OFF — 補正なし
mouse_click(x=500, y=300, homing=false)
```

`homing` パラメータは `mouse_click` / `mouse_move` / `mouse_drag` / `scroll` 全てで使えます。キャッシュは `screenshot()` / `get_windows()` / `focus_window()` / `workspace_snapshot()` 呼び出し時に自動更新されます。

---

## screenshot の主要パラメータ

```
detail="image"   — PNG/WebP 画像（デフォルト）
detail="text"    — UIA 要素 JSON + clickAt 座標（画像なし、~100-300 tok）
detail="meta"    — タイトル + 座標のみ（最軽量、~20 tok/窓）
dotByDot=true    — 1:1 WebP。image_px + origin = screen_px
diffMode=true    — 初回 I-frame、以降は変化した窓のみ P-frame（~160 tok）
```

**推奨ワークフロー:**
```
workspace_snapshot()                     → 全体把握（I-frame リセット）
screenshot(detail="text", windowTitle=X) → actionable[].clickAt でそのままクリック
mouse_click(x, y)
screenshot(diffMode=true)               → 変化した窓だけ確認（~160 tok）
```

---

## セキュリティ

### 緊急停止 (Failsafe)

**マウスをプライマリモニタの左上コーナー (座標 0,0 付近 10px 以内) に 500ms 置き続けると緊急停止が発動します。**

- 発動コーナーは**プライマリモニタのみ**。旧バージョンで発動していた領域（プライマリより左・上に配置したモニタ）ではもう発動しません。カーソルがそこに滞在した場合は、正しいコーナーを案内するバルーン通知を 1 回だけ表示します。
- **ツール呼び出しの実行中**: サーバは終了します (exit code 1) — 暴走オートメーションへのブレーキ。バルーン通知と診断ログ（カーソル座標付き）が停止理由を記録します。終了するのは実行中の呼び出しがある場合のみで、通知にかかる約 1 秒の間にその呼び出しが完了した稀なケースではサーバは生存し、訂正のバルーン通知が続けて表示されます。
- **アイドル時**: サーバは生存したまま、カーソルがコーナーを離れるまで新しいツール呼び出しを拒否します。背景の credential 自動入力 (`key_locker`) は**ダイアログが開く前に**中止されます — コーナーに置いている間、credential 入力ダイアログは表示されず、credential も入力されません。自動では再開しないため、カーソルをコーナーから離してからコマンドを実行し直してください。
- **ツール実行前チェック**: 各ツール呼び出しの開始時に毎回確認。**バックグラウンド監視**: 500ms 間隔のポーリング（長時間処理中のバックアップ）。コーナー判定範囲: 10px 以内。
- `DESKTOP_TOUCH_FAILSAFE_HOLD_MS` — 発動までの滞在時間 (ms)。既定 `500`、`0` = コーナー進入で即時発動。

### ブロックされる操作

**`workspace_launch` のブロックリスト:**  
`cmd.exe`, `powershell.exe`, `pwsh.exe`, `wscript.exe`, `cscript.exe`, `mshta.exe`, `regsvr32.exe`, `rundll32.exe`, `msiexec.exe`, `bash.exe`, `wsl.exe` は起動不可。  
`.bat`, `.ps1`, `.vbs` 等のスクリプトファイルも拒否。引数に `;`, `&`, `|`, `` ` ``, `$(`, `${` を含む場合も拒否。

**`keyboard(action='press')` のブロックリスト:**  
`Win+R`（Run ダイアログ）、`Win+X`（管理ツールメニュー）、`Win+S`（検索）、`Win+L`（ロック）は実行不可。

### PowerShell インジェクション対策

UIA ブリッジの PowerShell フォールバックパスでは、`-like` パターンに `escapeLike()` でワイルドカード文字 (`*`, `?`, `[`, `]`) をエスケープ済み。v0.15 以降、UIA の主パスは Rust ネイティブエンジン（直接 COM 呼び出し）のため、PowerShell は補助的なフォールバックとしてのみ使用されます。

---

## マウス移動速度

`mouse_move` / `mouse_click` / `mouse_drag` / `scroll` は全て `speed` パラメータ（省略可）を受け付けます。

| 値 | 動作 |
|---|---|
| 省略 | 設定済みのデフォルト速度を使用（下記参照） |
| `0` | 瞬間移動（`setPosition()` — アニメーションなし） |
| `1〜N` | N px/秒 でアニメーション移動 |

**デフォルト速度は 1500 px/秒**。環境変数 `DESKTOP_TOUCH_MOUSE_SPEED` で永続的に変更できます。

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"],
      "env": {
        "DESKTOP_TOUCH_MOUSE_SPEED": "3000"
      }
    }
  }
}
```

主な目安: `0` = テレポート、`1500` = デフォルト（ゆっくり）、`3000` = 速い、`5000` = 超速。

---

## Force-Focus (AttachThreadInput)

Windows のフォアグラウンド保護機能により、ピン固定された Claude CLI などが前面にある状態では `SetForegroundWindow` が拒否されることがあります。その結果、後続のキー入力やクリックが意図しないウィンドウに送られるサイレント障害が発生します。

`mouse_click`、`keyboard(action='type')`、`keyboard(action='press')`、`terminal(action='send')` はいずれも `forceFocus` パラメータを受け付けており、`AttachThreadInput` を使ってこの保護を迂回できます。

```json
{
  "name": "mouse_click",
  "arguments": {
    "x": 500,
    "y": 300,
    "windowTitle": "Google Chrome",
    "forceFocus": true
  }
}
```

強制フォーカスが拒否された場合、応答は `ok:false` + `code: "ForegroundRestricted"` (Issue #202 統一 — `focus_window` / `keyboard` / `terminal_send` / `mouse_click` で共通の shape) になります。当該操作自体は **抑止** され、誤ったウィンドウへキーストローク / クリックが届くことはありません。`focus_window` の auto-escalate ladder で先に focus を取得してから retry してください。旧 `hints.warnings: ["ForceFocusRefused"]` shape はもう発火しません。

別の仮想デスクトップにある窓は、前面に出しません（利用者のデスクトップが切り替わるため）。`keyboard` / `terminal` の send / マウス系（homing で前面に出すとき）は `code: "WindowOnOtherDesktop"` で断り、何も送りません。`context.sameTitleOnScreen: true` は、同じ題名の窓がいまのデスクトップにあるという意味です。その窓を正確に指定してください（道具が受け取るなら `hwnd`、そうでなければより詳しい `windowTitle`）。`focus_window` はこれまでどおり前面に出します。

**環境変数でグローバルデフォルトを設定する:**

```json
{
  "mcpServers": {
    "desktop-touch": {
      "env": {
        "DESKTOP_TOUCH_FORCE_FOCUS": "1"
      }
    }
  }
}
```

`DESKTOP_TOUCH_FORCE_FOCUS=1` を設定すると、4 つのツールすべてで `forceFocus: true` がデフォルトになります。

**既知のトレードオフ:**

- `AttachThreadInput` が有効な約 10ms の間、2 スレッド間でキー状態とマウスキャプチャが共有されます。高速なマクロ連打では稀にレース状態が発生する可能性があります。
- ユーザーが別のアプリを手動操作している間は `forceFocus` を無効にするか、環境変数の設定を解除してください。予期しないフォーカス移動を防ぐためです。

### `desktop_act` から Windows Terminal に打つ

Windows Terminal は、前面からのキー入力しか受け取りません。裏から送った文字は無視されます。`desktop_act` が Windows Terminal の窓に打つときは、MCP クライアントの質問画面で先に利用者へ訊きます（例："Type "echo hi" into Windows Terminal (PowerShell)? Takes the foreground ~0.2 s."）。そのため、MCP の elicitation に対応したクライアント（`elicitation` の機能を名乗るもの。MCP 2025-06-18 で追加）を stdio でつないでいる必要があります。Accept なら、前面を一瞬借りて貼り付け、元の窓に戻します。貼り付けのたびに必ず訊きます。訊かずに許可する方法はありません。Decline・Esc・120 秒以内に答えがない・質問を出せないクライアント（`claude -p` や、HTTP の接続を使うクライアント）は、どれも「許可なし」です。何も打たず、`foreground_not_allowed` と、理由を書いた `detail` を返します。「許可なし」の後に、利用者に訊かずに別の道で打たないでください。質問に全文を窓の題名・選ばれているタブと一緒に出すため、文字は1行で、それらを合わせて 600 文字以内に限ります。同じ題名の窓がほかにあるときは、質問に画面のどこにある窓かを添えます。同じ場所に重なっている場合は打ちません。答えるまでの間に窓や選ばれているタブが変わった場合は、何も打ちません。ペインに分割したタブと、選ばれているタブを読めない窓には打ちません（答えている間は、どのペインに入るかを読めないため）。前面にある端末には打ちません（クライアントがそのタブで動いていると、そこに入るため）。別の窓の端末を使ってください。貼り付けの前に、端末のキーボードの焦点を入力欄へ移します。開いたままの検索窓に文字が入らないようにするためで、移せないときは何も打ちません。末尾の改行1つは Enter として送ります。毎回訊くので、エージェントは複数のコマンドを1行にまとめる（`a; b`）ほうがよいです。

この質問は `desktop_act` の道でだけ出ます。`terminal(action:'run'/'send')` で Windows Terminal に送る道は、これまでどおり訊かずに前面を借りて貼り付けます。「許可なし」の後は、この道も使わないでください。

---

## UI オペレーティングレイヤー (V2)

> **ステータス: v0.17 からデフォルト ON。** `desktop_discover` / `desktop_act` はインストール直後から使えます。

V2 は、座標ベースのクリックをエンティティベースの操作に置き換える 2 つの新ツールを追加します。

| ツール | 説明 |
|---|---|
| `desktop_discover` | ウィンドウまたはブラウザタブを観測し、インタラクティブなエンティティを返します。raw 座標は返しません。UIA（ネイティブ）、CDP（ブラウザ）、ターミナル、GPU ビジュアルレーンに対応。`uiaClient: "classic"` で 2.0 の UI Automation クライアントで読みます（`desktop_act` を参照）。 |
| `desktop_act` | `desktop_discover` が返したエンティティを操作します。実行前にリースを検証し、セマンティック diff（`entity_disappeared`、`modal_appeared`、`focus_shifted` など）を返します。`diffUnchecked` があるときは、そこに挙がった種類を diff は確かめていません。diff に無くても、起きなかったとは限りません。視覚のみの対象では、成功時に `roiCapture`（変化領域の PNG ＋ 次対象の lease なしプレビュー）を同梱でき、「結果確認」と「次対象探索」を 1 コールで完了できます（`returnCapture`: `on-change` 既定で変化時に付与 / `never` で抑止 / `always` で常時）。`uiaClient: "classic"` は、既定のクライアントで扱えない窓のために、2.0 の UI Automation クライアントで操作します。キーボードの焦点を動かします（後ろの窓が手前に出て、その間に打ったキーを取ることがあり、窓を閉じた後はユーザーがクリックするまでマウスや窓の切り替えが効かないことがあります）。忙しい窓は待ち続けます（呼び出しは 8 秒以内に返りますが、裏では動き続けます。終わるまでは次の `classic` を断り、その窓への操作は既定のクライアントでも焦点を動かしえます。返事の `uiaClient.stillRunning` がそれを言います）。クライアントは呼び出しが終わったときに手放します。 |

### クリック優先順位

複数のツールが同じクリックを実行できる場合は、次の順番で優先してください:

1. `browser_click(selector)` — Chrome / Edge（CDP 経由、リペイントで座標がずれない）
2. `desktop_act(lease)` — ネイティブウィンドウ・ダイアログ・視覚のみの対象（`desktop_discover` 後に使用）
3. `click_element(name | automationId)` — `desktop_act` が `ok:false` の場合の UIA フォールバック
4. `mouse_click(x, y)` — 最終手段（`dotByDot` スクリーンショットの `origin`・`scale` が必要）

### V2 を無効にする（キルスイッチ）

`desktop_discover` / `desktop_act` をツールカタログから外したい場合は、disable フラグを追加して再起動します:

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"],
      "env": {
        "DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2": "1"
      }
    }
  }
}
```

V1 ツールはすべてそのまま動作します。再インストール不要。env を削除して再起動すれば V2 は再び有効になります。

フラグのセマンティクス（完全一致: 文字列 `"1"` のみ有効）:

| `DISABLE_FUKUWARAI_V2` | V2 状態 |
|---|---|
| 未設定 / `"1"` 以外 | **ON**（デフォルト） |
| `"1"` | **OFF**（kill switch） |

### スクリーンショットキャッシュ (by-ref ストレージ)

`screenshot` などの画像系応答は、ピクセルを毎回インライン展開する代わりに、ディスク保存した画像への安価なリンク `screenshot://by-ref/{id}` を返します（look→act→confirm の反復が大幅に低トークン化）。キャッシュは自動で上限管理され、`screenshot_query` / `screenshot_gc` で確認・掃除できます。

| 環境変数 | デフォルト | 効果 |
|---|---|---|
| `DESKTOP_TOUCH_SCREENSHOTS_DIR` | *(ユーザー別キャッシュ)* | キャッシュ保存先を固定。既定フォルダが作成・書き込み不可（ロックダウン PC など）の場合、この値 → runtime dir → OS の一時フォルダの順に書き込み可否を自動判定し、最初に書ける場所を使う（キャッシュを諦めない）。 |
| `DESKTOP_TOUCH_SCREENSHOT_MAX_COUNT` | `200` | 保持する最大キャプチャ数。 |
| `DESKTOP_TOUCH_SCREENSHOT_MAX_BYTES` | `256 MiB` | ディスク上のキャッシュ総量の上限。 |
| `DESKTOP_TOUCH_SCREENSHOT_MAX_AGE_MS` | *(無効)* | この経過時間（ms）より古いキャプチャを削除（opt-in）。 |
| `DESKTOP_TOUCH_SCREENSHOT_AUTOPRUNE` | `on` | 新規保存のたびに自動で間引く。`0` で無効化。 |
| `DESKTOP_TOUCH_SCREENSHOT_MIN_EVICT_AGE_MS` | `60000` | この時間（ms）より新しいキャプチャは自動退避しない。同一 PC 上で別の AI/プロセスが大量キャプチャしていても、渡したばかりの by-ref リンクが開けるよう保護。`0` で無効化。 |

### マルチモニタのスクリーンショット

`screenshot(displayId=…)` / `screenshot(region=…)` は、プライマリより左・上に置かれたモニタも含め、どのモニタでもキャプチャできます。これらのモニタの座標は負の値になりますが、`screenshot(detail='meta')` が返した値をそのまま渡してください。領域を指定しない `screenshot()` は従来どおりプライマリモニタ全面です。

キャプチャできない領域は、Windows の生エラーではなく `RegionOutsideCapturableBounds` として返り、3 つのうちどれに当たるかをメッセージが示します。どのモニタにも載っていない場合は、ウィンドウが移動・終了して座標が古くなったケースがほとんどなので、スクリーンショットを撮り直して新しい座標を使ってください。モニタには重なっているものの画面の範囲からはみ出している場合は、座標自体は正しく領域が大きすぎるだけなので、小さめの領域を指定するか、`screenshot(windowTitle=…)` でウィンドウ自体を撮ってください。3 つ目は、このサーバーがプライマリモニタしかキャプチャできない構成の場合で、これもメッセージに明記されます。この場合は「なぜそうなっているか」も併せて示され、対処が変わります。環境変数で切り替えている場合は `screenshot(windowTitle=…)` が引き続きどのモニタでも使えるのが通常で、ネイティブのキャプチャモジュールが欠落している場合はウィンドウ単位のキャプチャも同じモジュールを使うため失敗するのが通常です。その場合はウィンドウをプライマリモニタへ移すか、サーバーを再インストールしてください。ただし画面全体のキャプチャとウィンドウ単位のキャプチャはモジュール内の別々の部分で、片方だけが使えるサーバーもあり得ます。原因から推測せず、`screenshot(windowTitle=…)` が使えるかどうかはメッセージが明記するので、その記載に従ってください。

Windows が画素を返さなかった場合（ロック画面・UAC ダイアログ・切断されたリモートデスクトップなど）は `CaptureBackendFailed` です。この場合でも `screenshot(windowTitle=…)` は別の Windows API を使うため成功することが多いです。

| 環境変数 | デフォルト | 効果 |
|---|---|---|
| `DESKTOP_TOUCH_CAPTURE_BACKEND` | *(未設定 = 自動)* | 画面キャプチャ経路の切り分け用オーバーライド。`nutjs` を指定すると旧キャプチャ経路を強制でき、この経路では**プライマリモニタのみ**キャプチャ可能になります。バックエンドは起動時に一度だけ決まるため、MCP クライアント設定を変更してサーバーを再起動してください。それ以外の値は無視されます。 |

### 削除済み: `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2`

v0.16.x での opt-in フラグです。v0.17 以降は V2 がデフォルト ON のため、このフラグは効果を持たず、設定から削除して問題ありません。V2 を無効化するには `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` を設定してください。

### V2 が失敗した場合のリカバリ

`desktop_act` が `ok: false` を返した場合は `reason` を確認し、ツール説明のリカバリヒントに従ってください。よくあるパターン:

- `lease_expired` / `*_mismatch` / `entity_not_found` → `desktop_discover` を再実行してリースを更新
- `modal_blocking` → `response.blockingElement` (含まれていれば) が `{ name, role, automationId?, hwnd? }` を返す。`role: "dialog"` のときは別のダイアログ窓が対象の窓を無効にしており、`hwnd` がそれ — `target.hwnd = blockingElement.hwnd` で `desktop_discover` し直して答えてから retry。それ以外の role はスナップショットに写った窓で、OS が確かめられなかったもの — `hwnd` があれば `target.hwnd = blockingElement.hwnd` で `desktop_discover`、無ければ `click_element(name=blockingElement.name)` で閉じる。そのあと元の対象を discover し直して新しい lease で撃つ（同じ lease では再び拒まれる）
- `entity_outside_viewport` → 要素が画面外へ移動: 由来ウィンドウ内でスクロールアウトしたなら `scroll` / `scroll(action='to_element')`、ウィンドウごと移動・閉じたなら `desktop_discover` を再実行
- `origin_window_not_visible` → `focus_window(windowTitle)` で最小化 / 非表示のウィンドウを復元してから `desktop_discover` を再実行
- `coordinate_outside_reachable_bounds` → 座標がどのモニタ上にも無い（通常は座標が古い）: `desktop_discover` を再実行する。内蔵 Windows 入力モジュール無しの構成ではプライマリモニタのみ到達可（その旨がメッセージに出る）
- `cursor_placement_blocked` → ポインタをそこへ置けずクリックは送られていない（アプリがカーソルを掴んでいる / セッションが非対話）: カーソルを解放するかセッションに再接続する、または `click_element`（UIA invoke、カーソル非使用）を使う
- `keyboard_target_unsafe` → 何も入力されていない: 文字が別のコントロール / ウィンドウ、または読み取り専用のコントロールへ行くところだった。あるいは指定した欄（かそのウィンドウ）が無効だった（どれかは `if_unexpected.detail`。無効なら、無効にしているものが済んでから discover し直す）。指定した欄にフォーカスを移してから入力し直す——前面の `keyboard` では打ち直さない。タイトル指定なら `desktop_act` の `action='click'`、ハンドル指定ならタイトルで discover し直してから（ただし共通ダイアログはタイトルもハンドルに解決するので、そこではテキスト欄にフォーカスを移す道が無い）。別のウィンドウのときは先に `focus_window`
- `executor_failed` → `if_unexpected.detail` が "Nothing was typed" で始まるときは、どの経路も走っておらず何も入力されていない — detail のとおりにする。それ以外は desktop_act が取った経路が失敗した。クリックなら `click_element` / `mouse_click` / `browser_click` に、入力なら欄にフォーカスして `keyboard(action='type', method='foreground')` にフォールバック

`desktop_discover` が warnings（`visual_provider_unavailable`、`visual_provider_warming`、`cdp_provider_failed` 等）を返した場合も、V1 ツール（`screenshot`、`click_element`、`get_ui_elements`、`terminal(action='send')` など）がエスケープハッチとして使えます。

---

## ネイティブエンジンの性能（v0.15 時点の計測）

### UIA ブリッジ — Rust ネイティブ vs PowerShell

| 関数 | Rust Native | PowerShell | 高速化 |
|---|---|---|---|
| `getFocusedElement` | **2.2 ms** | 366 ms | 🚀 **163.9×** |
| `getUiElements` | **106.5 ms** | 346 ms | 🚀 **3.3×** |
| **平均** | | | **🚀 ~82×** |

### 画像差分エンジン — Rust SSE2 SIMD vs TypeScript

| 関数 | Rust SSE2 | TypeScript | 高速化 |
|---|---|---|---|
| `computeChangeFraction` (1080p) | **0.26 ms** | 3.8 ms | 🚀 **~15×** |
| `dHash` (1080p) | **0.09 ms** | 1.2 ms | 🚀 **~13×** |

### アーキテクチャ概要

```
Claude CLI → MCP Server (TypeScript)
                ├── Rust Native Engine (.node addon)
                │     ├── UIA: 専用 MTA スレッド → 直接 COM 呼び出し
                │     └── Image: SSE2 SIMD カーネル
                └── PowerShell フォールバック（自動切替）
```

- **バッチ型 BFS**: `FindAllBuildCache(TreeScope_Children)` による階層ごとの一括フェッチ。`maxElements` 到達で即打ち切りし、巨大ツリーでもスケーラブル。
- **自動フォールバック**: ネイティブエンジンが利用不可の場合、全関数が PowerShell に透過切替 — 設定不要。

---

## パフォーマンス目安

| モード | 転送トークン | 用途 |
|---|---|---|
| `screenshot` (768px PNG) | ~443 tok | 一般的な視覚確認 |
| `screenshot(dotByDot=true)` ウィンドウ | ~800 tok | 精密クリック（座標変換不要） |
| `screenshot(diffMode=true)` | ~160 tok | 操作後の差分確認 |
| `screenshot(detail="text")` | ~100-300 tok | UI 操作（画像不要） |
| `workspace_snapshot` | ~2000 tok | セッション開始時の全体把握 |

---

## Claude へのシステムプロンプト（自動注入）

**設定は不要です。** MCP 接続時にコマンドリファレンスが自動的に Claude へ送信されます。

MCP `initialize` レスポンスの `instructions` フィールドを利用しており、Claude CLI がセッション開始時に自動でシステムプロンプトへ組み込みます。以下は送信される内容の参考です。

```
# desktop-touch-mcp 操作指針

## 情報収集の優先順位（トークン節約）
1. workspace_snapshot() → セッション開始時・全体把握が必要な時のみ
2. screenshot(detail="text", windowTitle=X) → UI操作（ボタン名・入力欄の確認）
3. screenshot(diffMode=true) → 操作後の確認（変化した窓のみ ~160 tok）
4. screenshot(dotByDot=true, windowTitle=X) → 精密座標が必要な時のみ
5. screenshot(detail="image") → 視覚的確認が必要な時のみ（最重量）

## 座標の扱い
- detail="text" の actionable[].clickAt は画面座標として直接 mouse_click に渡せる（変換不要）
- dotByDot=true の場合: screen_x = origin_x + image_x（レスポンスのoriginを参照）
- デフォルト PNG の場合: screen_x = window.x + image_x * (window.width / image.width)

## 操作ループの基本形
workspace_snapshot() → detail="text" で要素確認 → mouse_click/keyboard(action='type') → diffMode=true で確認

## 日本語入力
keyboard(action='type')(use_clipboard=true) を使うこと（IME バイパス）
```

---

## `workspace_launch` 起動許可リスト

セキュリティ上、`cmd.exe` / `powershell.exe` 等のシェルインタープリタはデフォルトでブロックされます。  
特定の実行ファイルを許可するには **allowlist ファイル** を作成してください。

**設定ファイルの場所（上から順に検索）:**
1. 環境変数 `DESKTOP_TOUCH_ALLOWLIST` で指定したパス
2. `~/.claude/desktop-touch-allowlist.json`
3. サーバー実行ディレクトリ直下の `desktop-touch-allowlist.json`

**フォーマット:**
```json
{
  "allowedExecutables": [
    "pwsh.exe",
    "C:\\Tools\\myapp.exe"
  ]
}
```

ファイルの変更は即時反映されます（再起動不要）。

---
