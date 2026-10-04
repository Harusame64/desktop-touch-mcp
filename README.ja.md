# desktop-touch-mcp

[![desktop-touch-mcp MCP server](https://glama.ai/mcp/servers/Harusame64/desktop-touch-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Harusame64/desktop-touch-mcp)

[English](README.md)

> **Windows 用 computer-use MCP サーバー。** Claude / Cursor / VS Code Copilot などの MCP クライアントから、あなたの Windows 10/11 デスクトップを「見て」「操作」させられます — スクリーンショット、UI Automation、Chrome CDP、キーボード / マウス、ターミナル。座標ルーレットではない **セマンティックな discover-then-act 設計** と、誤ウィンドウへの入力を未然に防ぐ **action 毎の perception guard** が特徴です。

```bash
npx -y @harusame64/desktop-touch-mcp
```

32 ツール、Rust ネイティブエンジン (UIA 2ms)、PowerShell 透過フォールバック、日本語/CJK 完全対応、MIT。上記 1 行を Claude / Cursor / VS Code Copilot の MCP 設定に追加するだけで、Notepad、Excel、Chrome、Windows Terminal、その他あらゆるアプリを Claude が操作できるようになります。

> *v2.1: UI Automation を深さでなく要素数で読むようにした。Chrome・Edge・VS Code のページ、Explorer と設定の値、Word の本文が読めて、操作できる。UIA で読めないものは、これまでどおり OCR と Set-of-Marks に回る。Word の本文と、利用者に訊いたうえで Windows Terminal にも打てる。（[CHANGELOG](CHANGELOG.md)）*
> *v2.0: できない操作は「できた」と返さず、理由をつけて断る。`hwnd` で指した操作は、その窓にだけ届く。*

---

## 特徴

- **🔁 押したら、何が起きたかが返る** — `desktop_act` は操作の後に、何が変わったかを応答に入れて返します。現れた・消えた要素、モーダル、フォーカスの移動、画面の再描画（`observation`）、`narrate:"rich"` なら変わった値と名前まで。クリックの結果を確かめるために、もう一度スクリーンショットを撮る必要がありません。UIA が効かない対象では、変化した領域だけの PNG も同梱できます（`roiCapture`。見える変化があれば既定で付与、`returnCapture:"never"` で抑止、`"always"` で常時）。
- **🛑 できない操作は「できた」と言わない** — 指定した欄に届かない入力、ダイアログに塞がれた窓、閉じた窓、別の仮想デスクトップの窓には、何も送らずに断り、理由と次の手を返します。`hwnd` で指した操作は、同じ題名の別の窓には届きません。
- **🌐 深い窓まで読む（v2.1）** — UI Automation を深さ 64・500 要素まで読みます。2.0 では「読めない」と答えていた Chrome・Edge・VS Code のページ、値が欠けていた Explorer と設定、Word の本文が読めて、操作できます（例: Chrome のページは 6 要素・387 ms → 45 要素・186 ms）。
- **🎯 Set-of-Marks（SoM）ビジュアルフォールバック** — ゲーム・RDP・アクセシビリティの木を持たないアプリなど、UIA が見えない窓でも、`desktop_discover` と `screenshot(detail="text")` が Hybrid Non-CDP パイプラインに切り替えます。Rust 画像前処理 → Windows OCR → クラスタリング → 赤い枠線 + 番号バッジ（`[1]`、`[2]`…）付き PNG を生成し、`clickAt` 座標付きの要素リストを返します。CDP 不要。
- **⌨️ 裏からの入力が届かない窓にも打つ** — Windows Terminal には毎回利用者に訊いてから貼り付けます（MCP の elicitation に対応したクライアントを stdio で）。Word の本文には、Word が前面でも裏でもキャレット位置に打ちます。
- **🔐 Key Locker — SSH / sudo のパスワードをターミナルが自動入力** — 認証情報はロッカー自身のセキュアダイアログに一度だけ入力して、この PC 上に暗号化保存（Windows DPAPI）— アシスタントには一切見えません。以後は `key_locker(action='launch_console')` で開いたコンソールで `ssh` / `sudo` を実行するだけで、隠しパスワードプロンプトに自動入力されます（既定では入力毎に確認あり）。詳細は [Key Locker](docs/guide.ja.md#key-locker-ターミナル認証情報の自動入力) 参照。
- **⚡ Rust ネイティブコア** — UIA ブリッジと画像差分を Rust（`napi-rs` + `windows-rs`）のネイティブアドオンで実装。UIA は専用スレッドから COM で直接呼び、PowerShell を起動しません。画像差分は SSE2 SIMD。アドオンが無い環境では、全関数が PowerShell に透過フォールバックします。npm ランチャーは、入れた版に対応する GitHub Release だけを取得し、Windows 用 zip を検証してから展開します。
- **LLM ネイティブ設計** — 人間の操作を模倣するのではなく、「LLM がいかにコンテキストを消費せず高速に動けるか」を前提に設計。`run_macro` による複数操作の一括実行（API 往復の削減）と、**MPEG P-frame 方式のレイヤー差分** (`diffMode`) を組み合わせることで、無駄な画像転送や推論ループを極限まで削ぎ落とす。
- **Reactive Perception Graph** — ウィンドウやブラウザタブに `lensId` を登録し、以後の action tool に渡すだけで、操作前の安全 guard と操作後の `post.perception` フィードバックを受け取れます。`screenshot` / `desktop_state` の反復を減らし、別ウィンドウへの誤入力や古い座標クリックを防ぎます。
- **日本語/CJK 完全対応** — ウィンドウタイトル取得に Win32 `GetWindowTextW` を使用。nut-js の文字化けを回避。IME バイパス入力にも対応。
- **3 段階トークン削減** — `detail="image"`（~443 tok）/ `detail="text"`（~100-300 tok）/ `diffMode=true`（~160 tok）を用途に応じて使い分け。視覚確認が必要な時だけ画像を送る。
- **座標変換不要の 1:1 モード** — `dotByDot=true` で WebP 1:1 キャプチャ。画像上のピクセル座標 = 画面座標なのでスケール計算が不要。
- **ブラウザキャプチャのデータ削減** — `grayscale=true`、`dotByDotMaxDimension=1280`、`windowTitle + region` の部分切り出しで、ブラウザ chrome や不要な余白を除外。重いキャプチャで 50〜70% 程度の削減を狙えます。
- **UIA アクション要素抽出** — `detail="text"` でボタン・入力欄の名前と `clickAt` 座標を JSON で返すため、画像を見なくても操作できる。
- **Chromium スマートフォールバック** — Chrome/Edge/Brave に対して `detail="text"` を使うと、低速な UIA を自動スキップし Windows OCR を実行。`hints.chromiumGuard` + `hints.ocrFallbackFired` で経路を判別可能。
- **CLI 自動ドック** — `window_dock(action='dock')` でウィンドウを画面隅にスナップ＆最前面固定。`DESKTOP_TOUCH_DOCK_TITLE='@parent'` を設定すると、MCP 起動時にプロセスツリーを辿って Claude CLI をホストするターミナルを自動ドック。
- **緊急停止 (Failsafe)** — マウスを**プライマリモニタの左上コーナー (0,0 付近 10px)** に 500ms 置くと緊急停止が発動。

---

## 前提環境

| 項目 | 要件 |
|---|---|
| OS | Windows 10 / 11 (64-bit)。**Apple Silicon の macOS 14 以降はプレビュー** — [macOS（プレビュー）](#macosプレビュー) を参照 |
| Node.js | v20 以上推奨 (v22+ で動作確認済み) — **開発と試験の実行には `^22.12 || ^24 || >=26`**（#658 以降の試験の走り手の範囲。23 や 25 のような奇数メジャーは外れる） |
| PowerShell | 5.1 以上 (Windows 標準同梱) — Rust ネイティブエンジン不在時のフォールバック用 |
| Claude CLI | `claude` コマンドが使えること |

> **注意:** nut-js のネイティブバインディングは Visual C++ 再頒布可能パッケージを必要とします。  
> インストール済みでない場合は [Microsoft公式](https://learn.microsoft.com/ja-jp/cpp/windows/latest-supported-vc-redist) からダウンロードしてください。

> **注意 (Key Locker):** Key Locker が使う認証情報ヘルパーは未署名の実行ファイルのため、環境によっては初回起動時に Windows SmartScreen やアンチウイルスが「発行元不明」の警告を表示することがあります。これは想定内で、ヘルパーは desktop-touch-mcp に同梱され、お使いのマシン上でローカルに動作します。許可して続行して問題ありません。（コード署名は今後のリリースで対応予定です。）

---

## インストール

```bash
npx -y @harusame64/desktop-touch-mcp
```

npm ランチャーは npm package version に厳密に対応する runtime だけを取得します。`X.Y.Z` を実行した場合は GitHub Release `vX.Y.Z` のみを参照し、お使いの環境の zip（`desktop-touch-mcp-windows.zip`、Apple Silicon の Mac では `desktop-touch-mcp-macos-arm64.zip`）をダウンロードして SHA256 を検証できた場合にだけ `%USERPROFILE%\.desktop-touch-mcp`（macOS では `~/.desktop-touch-mcp`）へ展開します。検証済みキャッシュは次回以降も再利用されます。

キャッシュの保存先は `DESKTOP_TOUCH_MCP_HOME` で変更できます。

> **共有ネットワークや CI 環境の場合:** 初回起動時に GitHub Releases API を参照して
> runtime zip を探します。匿名アクセスの上限は IP あたり 60 回/時で、共有グローバル IP
> （CI ランナー、オフィスの NAT など）ではダウンロード開始前に枯渇することがあります。
> 環境変数に `GITHUB_TOKEN`（または `GH_TOKEN`）を設定すると API 呼び出しが認証され、
> 上限が 5,000 回/時に上がります。通常の家庭回線ではトークンは不要です。

> **ソースチェックアウトから launcher を実行する場合:** ソースビルドの
> `bin/launcher.js` は確定済みの整合性ハッシュではなくプレースホルダ
> （`sha256: "PENDING"`）を持ちます。検証できない runtime をダウンロードして実行する
> 代わりに launcher は fail-closed で停止し、誤って publish された／未確定の launcher が
> 検証されていないコードを黙って起動するのを防ぎます。publish 済みの npm リリースは
> 常に本物の SHA256 を同梱するため、利用者がこの状態に遭遇することはありません。
> 意図的にソースから launcher を実行する場合は `DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED=1`
> を設定すると整合性検証をスキップできます（開発用途のみ）。

> **ホスト側の起動タイムアウトに間に合わない場合:** デスクトップホストによっては
> プラグインが ready になるまでの時間に上限（60 秒程度が一般的）があり、GitHub に
> 到達できない状態の launcher がその時間を使い切ってしまうことがあります。この場合は
> 次の 2 つの環境変数を使えます。
>
> `DESKTOP_TOUCH_MCP_FETCH_TIMEOUT_MS`（既定値 `15000`）は GitHub から応答が無い
> まま待ち続ける時間の上限です。リリース情報の取得とダウンロードの両方に適用され、
> ダウンロードでは「無通信時間」を計測するため（全体の制限時間ではないため）低速回線
> でも大きな runtime を最後までダウンロードできます。正の数値でない値は警告付きで
> 無視されます。
>
> `DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK=1` を設定すると、GitHub に全く到達できない
> ときにインストール済みのリリースで起動します。既定では無効です。GitHub には必ず
> 先にアクセスするため、ネットワークが生きていれば従来どおり壊れたインストールは
> 再ダウンロードで修復されます。フォールバックに到達するのはネットワーク障害の場合
> だけで、そのときは手元にある該当バージョンを再検証なしで起動し、該当バージョンが
> 未インストールなら検証済みインストールが完了している中で最も新しい旧バージョンを
> 起動します。ネットワーク障害ではない応答（404、API レート制限、整合性ハッシュ
> 不一致）は従来どおり起動を停止します。ホスト側のタイムアウトで必要になった場合を
> 除いて無効のままにしてください: 有効な間は、現在のバージョンのインストールが壊れて
> いても修復されず再利用されます。
>
> 2 つは組み合わせて使います。フォールバックが有効でも、まずタイムアウトまで待って
> から手元のリリースに切り替わるため、ホスト側の制限時間が短い場合は
> `DESKTOP_TOUCH_MCP_FETCH_TIMEOUT_MS` を下げてください。なお、遅くてもデータが
> 届き続けているダウンロードは中断されません（フォールバックが働くのは「無通信」に
> なったときで、「低速」なときではありません）。

### Claude CLI への登録

`~/.claude.json` の `mcpServers` に追加：

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"]
    }
  }
}
```

### HTTP モードでの起動（GPT Desktop / VS Code / Cursor など）

HTTP 接続が必要なクライアントには `--http` フラグを使います。

```bash
npx -y @harusame64/desktop-touch-mcp --http
# ポートを変更する場合:
npx -y @harusame64/desktop-touch-mcp --http --port 8080
```

デフォルトポートは `23847`。`http://127.0.0.1:23847/mcp` をクライアントの MCP サーバー URL に登録してください（ローカルのみ、外部公開なし）。
ヘルスチェック: `http://127.0.0.1:<port>/health`

HTTP モード起動時はタスクトレイにバルーン通知が表示され、右クリックメニューから URL コピー・ブラウザで確認・終了が行えます。

### 開発用インストール

```bash
git clone https://github.com/Harusame64/desktop-touch-mcp.git
cd desktop-touch-mcp
npm install
```

`npm install` 後にビルドを実行してください。

```bash
npm run build
```

ローカルチェックアウトを使う場合は、ビルド済みのサーバーを直接登録します。

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/path/to/desktop-touch-mcp/dist/index.js"]
    }
  }
}
```

> **注意:** `D:/path/to/desktop-touch-mcp` の部分は、このリポジトリをクローンした実際のパスに変更してください。


## macOS（プレビュー）

Apple Silicon の Mac（macOS 14 以降）では、同じ `npx` で macOS 用のサーバーが起動します。使えるツールは `desktop_state`・`desktop_discover`・`desktop_act`（押す・文字の置き換え／追記）・`screenshot`（ウィンドウ1枚）の4つです。ほかのツールは Windows 専用で、macOS では一覧に出ません。

- サーバーを動かすアプリ（ターミナル、iTerm、VS Code、Claude アプリなど）に、システム設定 › プライバシーとセキュリティ で **アクセシビリティ** を、ウィンドウのタイトルとスクリーンショットには **画面収録** も許可し、アプリを再起動してください。許可がないあいだ、ツールは `PermissionRequired` と、何を許可すればよいかを返します。
- インストールは `npx` だけにしてください。ブラウザでダウンロードしたリリースの zip は Gatekeeper に拒否されます（ネイティブモジュールは公証していません）。
- stdio のみです（`--http` はまだ使えません）。Intel の Mac と Linux には対応していません。

---

## ツール一覧 (32 ツール — 30 stub catalog + 2 dynamic v2)

> 📖 **詳細リファレンス**: [`docs/system-overview.md`](docs/system-overview.md) — 各ツールのパラメータ・応答形式・座標計算・レイヤーバッファ・技術ノートを網羅（英語）。

### スクリーンショット系 (5)
| ツール | 概要 |
|---|---|
| `screenshot` | メインキャプチャ。`detail` / `dotByDot` / `dotByDotMaxDimension` / `grayscale` / `region` / `diffMode` 対応。画像はインライン展開せず、ディスク保存した画像への安価なリンク `screenshot://by-ref/{id}` を返す |
| `screenshot_background` | 背面・最小化ウィンドウをキャプチャ (PrintWindow API) |
| `screenshot_ocr` | Windows OCR で文字と `clickAt` 座標を取得 |
| `get_screen_info` | モニター解像度・DPI・カーソル位置 |
| `scroll(action='capture')` | ページ全体をスクロールしながらスティッチ |

### スクリーンショットキャッシュ (2)
| ツール | 概要 |
|---|---|
| `screenshot_query` | by-ref リンクの裏にあるディスクキャッシュの一覧を、ピクセルを再読込せずに取得（captureId・by-ref uri・サイズ・寸法・時刻・tag、キャッシュ全体の合計）。パスは一切返さない |
| `screenshot_gc` | 保持ポリシー（最新 N 件 / バイト上限 / 経過時間）でキャッシュを掃除。既定は dry-run（削除対象の一覧のみ）。実削除は `dryRun:false` かつ `confirm:true` の両方が必要 |

### ウィンドウ管理 (4)
| ツール | 概要 |
|---|---|
| `get_windows` | 全ウィンドウを Z-order 順で一覧 |
| `get_active_window` | フォーカス中ウィンドウの情報 |
| `focus_window` | タイトル部分一致でフォアグラウンドに移動。ChromeタブURL指定にも対応 |
| `window_dock(action='dock')` | Claude CLIなどを画面隅にドックして最前面固定 |

### マウス操作 (5)
| ツール | 概要 |
|---|---|
| `mouse_move` / `mouse_click` / `mouse_drag` | 移動・クリック・ドラッグ。`speed` / `homing` / `forceFocus` 対応 |
| `scroll` | 上下左右スクロール。`speed` / `homing` 対応 |
| `get_cursor_position` | 現在カーソル座標 |

### キーボード操作 (2)
| ツール | 概要 |
|---|---|
| `keyboard(action='type')` | テキスト入力。`use_clipboard=true` で IME バイパス、非ASCII記号は自動clipboard経路 |
| `keyboard(action='press')` | `ctrl+c` / `alt+tab` / `f5` などのキー入力・修飾キー組み合わせ |

### UI Automation (4)
| ツール | 概要 |
|---|---|
| `get_ui_elements` | UIA 要素ツリー取得 |
| `click_element` | 名前/AutomationId でボタンやメニューをクリック (座標不要) |
| `set_element_value` | テキストフィールドに直接値をセット |
| `scope_element` | 要素を高解像度ズームキャプチャ + 子ツリー |

### Browser CDP (9)
| ツール | 概要 |
|---|---|
| `browser_open` | Chrome/Edge に CDP 接続してタブ一覧取得。`launch:{}` を渡すと CDP エンドポイントが無いとき自動でデバッグモード起動（idempotent — 既存エンドポイントがあれば spawn skip） |
| `browser_locate` | CSS セレクター → 物理ピクセル座標 |
| `browser_click` | DOM 要素を検索してクリック（1ステップ） |
| `browser_eval` | タブ上の操作を 3 アクションで提供：`js`（JS 評価）/ `dom`（HTML 取得）/ `appState`（SSR 注入された SPA state を抽出 — `__NEXT_DATA__` / `__NUXT_DATA__` / `__REMIX_CONTEXT__` / `__APOLLO_STATE__` / GitHub `react-app` / JSON-LD / Redux SSR） |
| `browser_fill` | React/Vue/Svelte の controlled input をCDPで安全に入力 |
| `browser_form` | フォーム配下の input/select/textarea/button を name・type・value・label 付きで列挙 |
| `browser_overview` | リンク/ボタン/入力 + ARIA トグルを状態付きで列挙 |
| `browser_search` | text / regex / role / ariaLabel / selector で DOM を grep（confidence 順） |
| `browser_navigate` | CDP 経由で URL 遷移。`waitForLoad:true` が既定 |

DOM を触る `browser_*` ツールは `includeContext:false` で末尾の `activeTab:` / `readyState:` 2 行を省略可（連続呼び出しで ~150 tok/call 削減）。500ms 以内の連続 call は getTabContext を内部キャッシュで 1 回に圧縮。

### ワークスペース (2)
| ツール | 概要 |
|---|---|
| `workspace_snapshot` | 全ウィンドウをサムネイル + UI 要素サマリで一括取得 |
| `workspace_launch` | アプリ起動 + 新ウィンドウ自動検出 |

### コンテキスト・待機・履歴 (8)
| ツール | 概要 |
|---|---|
| `desktop_state` | フォーカス中ウィンドウ・要素・カーソル・ページ状態を軽量取得 |
| `get_history` | 直近ツール履歴を取得 |
| `get_document_state` | Chromeページ状態（URL/title/readyState/scroll）をCDPで取得 |
| `server_status` | 各サブシステムの動作バックエンドを返す：`uia`（Rust native または powershell）/ `imageDiff`（Rust SSE2 または typescript）。診断用 — パフォーマンス調査時に1回呼ぶ |
| `wait_until` | window/focus/terminal/browser DOM などの状態変化をサーバー側で待機 |
| `events_subscribe` / `events_poll` / `events_unsubscribe` / `events_list` | ウィンドウ出現・消滅・フォーカス変化を購読/取得 |

### ターミナル (2)
| ツール | 概要 |
|---|---|
| `terminal(action='run')` | コマンド送信 → 完了待ち → 出力取得を 1 コールで実行。完了判定は `until`: `quiet` / `pattern` / `exit`（コマンドの**終了**を待ち exit code を返す → [ターミナルの完了判定](docs/guide.ja.md#ターミナルの完了判定-until)） |
| `terminal(action='read')` | Windows Terminal / PowerShell / cmd / WSL のテキストをUIA/OCRで取得。`sinceMarker`差分対応 |
| `terminal(action='send')` | ターミナルへコマンド送信。clipboard paste既定でIME安全 |

### ピン・マクロ (3)
| ツール | 概要 |
|---|---|
| `window_dock(action='pin')` / `unwindow_dock(action='pin')` | 最前面固定 / 解除 |
| `run_macro` | 最大 50 ステップを順次実行 |

### Clipboard / Notification (3)
| ツール | 概要 |
|---|---|
| `clipboard(action='read')` / `clipboard(action='write')` | Windows clipboard のテキスト読み書き。Unicode/CJK対応 |
| `notification_show` | 長時間タスク完了時などにWindows通知を表示 |

### 高度スクロール (2)
| ツール | 概要 |
|---|---|
| `scroll(action='to_element')` | 要素名またはCSS selectorで対象をviewportへスクロール |
| `scroll(action='smart')` | CDP → UIA → 画像binary-searchの統合スクロール。ネスト・仮想リスト・sticky header対応 |

### Office (Excel) (1)
| ツール | 概要 |
|---|---|
| `excel` | Excel VBA マクロを COM 経由で記述・実行。`action='run_vba'` はマクロを管理下の Trusted Location に書き込んで実行、`action='check_access_vbom'` は読み取り専用の事前チェック。数式だけでは届かない処理を VBA で実行。初回のみ `node scripts/enable-access-vbom.mjs` |

### Key Locker (1)
| ツール | 概要 |
|---|---|
| `key_locker` | ターミナルが自動入力する認証情報（SSH 鍵のパスフレーズ、sudo / ログインパスワード）を管理。秘密情報はロッカー自身のセキュアダイアログに一度だけ入力し、この PC 上で暗号化保存（Windows DPAPI, current user）— アシスタントには一切見えない。`action='launch_console'` で自動入力対応コンソールを起動（返る `paneId` を `terminal` に渡して `ssh`/`sudo` を流す）/ `save`（登録）/ `list` / `forget` / `set_policy` / `status`。自動入力は `launch_console` で開いたコンソールでのみ発火。`DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1` で無効化 |

---

## 推奨ワークフロー (v1.0.0)

v2 World-Graph (`desktop_discover` / `desktop_act`) が標準ディスパッチパス。ネイティブアプリ・ブラウザ・ターミナルを同じ 4 ステップで扱えます。

```
desktop_state          → 状況把握: focused window/element / modal / attention
desktop_discover       → 操作可能 entity を取得 (lease + windows[] 付き)
desktop_act(lease, …)  → entity 操作 (attention + post.perception を返す)
desktop_state          → 期待通りに状態が変わったか確認
```

クリック優先順:

```
browser_click(selector)               → Chrome / Edge (CDP、再描画に強い)
desktop_act(lease, action='click')    → ネイティブ / ダイアログ / ビジュアル (entity ベース)
click_element(name | automationId)    → desktop_act が ok:false の時の UIA フォールバック
mouse_click(x, y, origin?, scale?)    → 最終手段。dotByDot screenshot の origin+scale を使うこと
```

拒否ごとの戻り方と lease の期限: [ガイド → リカバリと lease](docs/guide.ja.md#リカバリと-lease)。

---

## ガイドに続く

詳細は[ガイド](docs/guide.ja.md)にあります:

- [リカバリと lease](docs/guide.ja.md#リカバリと-lease)
- [ターミナルの完了判定 (`until`)](docs/guide.ja.md#ターミナルの完了判定-until)
- [Key Locker (ターミナル認証情報の自動入力)](docs/guide.ja.md#key-locker-ターミナル認証情報の自動入力)
- [ブラウザ CDP 自動化](docs/guide.ja.md#ブラウザ-cdp-自動化)
- [マウスホーミング補正（トラクションコントロール）](docs/guide.ja.md#マウスホーミング補正トラクションコントロール)
- [screenshot の主要パラメータ](docs/guide.ja.md#screenshot-の主要パラメータ)
- [セキュリティ](docs/guide.ja.md#セキュリティ)
- [マウス移動速度](docs/guide.ja.md#マウス移動速度)
- [Force-Focus (AttachThreadInput)](docs/guide.ja.md#force-focus-attachthreadinput)
- [UI オペレーティングレイヤー (V2)](docs/guide.ja.md#ui-オペレーティングレイヤー-v2)
- [ネイティブエンジンの性能（v0.15 時点の計測）](docs/guide.ja.md#ネイティブエンジンの性能v015-時点の計測)
- [パフォーマンス目安](docs/guide.ja.md#パフォーマンス目安)
- [Claude へのシステムプロンプト（自動注入）](docs/guide.ja.md#claude-へのシステムプロンプト自動注入)
- [`workspace_launch` 起動許可リスト](docs/guide.ja.md#workspace_launch-起動許可リスト)

---

## 既知の制限

| 制限 | 詳細 | 回避策 |
|---|---|---|
| ゲーム・動画プレイヤーの背面キャプチャが黒またはハング | DirectX フルスクリーン等は `PW_RENDERFULLCONTENT (flag=2)` でも再描画してくれないことがある。v1.4.4 以降、window-targeted `screenshot(detail='image')` は PrintWindow が何も返さない場合と all-black + zero-variance フレームを返した場合に BitBlt fallback へ自動で切り替わるが、PrintWindow がハングするケースは fallback されない | `screenshot({mode:'background', fullContent:false})` で旧 PrintWindow フラグに切り替え。それでも黒なら default `mode='normal'` の BitBlt fallback が画面の rect を返す (`hints.captureFallbackReason: 'printwindow-all-black'` で識別可能) |
| UIA 呼び出しのオーバーヘッド | Rust ネイティブ: フォーカス取得 ~2ms、ツリー走査 ~100ms。PowerShell フォールバック: ~300ms | 操作前に `workspace_snapshot` で一括取得し、以降は `diffMode` で差分確認 |
| `screenshot(detail='text')` で Chrome / WinUI3 の UIA 要素が少ない | この読みは Chromium では浅いまま（`desktop_discover` は 2.1 からページの部品を読む） | ページの部品は `desktop_discover` で。DOM ベースのクリックは `browser_open` + `browser_locate`。視覚確認のみなら `screenshot(detail="image")` |
| レイヤーバッファの TTL | 90 秒操作なしでバッファが自動クリア → 次回 `diffMode` が I-frame になる | 長い待機後は `workspace_snapshot` で明示的にリセット |

---

## 謝辞

このツールを試し、Issue や PR、バグ報告で貢献してくれたすべての方に感謝します。
皆さんの声が次のリリースをより良くしてくれました。一緒に育ててくれてありがとう！

---

## ライセンス

MIT
