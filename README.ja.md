# desktop-touch-mcp

[![desktop-touch-mcp MCP server](https://glama.ai/mcp/servers/Harusame64/desktop-touch-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Harusame64/desktop-touch-mcp)

[English](README.md)

> **Windows 用 computer-use MCP サーバー。** Claude / Cursor / VS Code Copilot などの MCP クライアントから、あなたの Windows 10/11 デスクトップを「見て」「操作」させられます — スクリーンショット、UI Automation、Chrome CDP、キーボード / マウス、ターミナル。座標ルーレットではない **セマンティックな discover-then-act 設計** と、誤ウィンドウへの入力を未然に防ぐ **action 毎の perception guard** が特徴です。

```bash
npx -y @harusame64/desktop-touch-mcp
```

32 ツール、Rust ネイティブエンジン (UIA 2ms)、PowerShell 透過フォールバック、日本語/CJK 完全対応、MIT。上記 1 行を Claude / Cursor / VS Code Copilot の MCP 設定に追加するだけで、Notepad、Excel、Chrome、Windows Terminal、その他あらゆるアプリを Claude が操作できるようになります。

> *v0.15: Rust ネイティブエンジンにより**平均 82 倍高速化** — UIA フォーカス取得 2ms、SSE2 SIMD 画像差分 13〜15 倍速。設定不要：エンジンは自動ロード、不在時は PowerShell に透過フォールバック。*
> *v0.15.5: **固定リリース検証** — npm ランチャーは対応する GitHub Release tag だけを取得し、Windows runtime zip を検証してから展開します。*

---

## 特徴

- **⚡ 高性能 Rust ネイティブコア** — UIA ブリッジと画像差分エンジンを Rust (`napi-rs` + `windows-rs`) で実装し、ネイティブ `.node` アドオンとしてロード。専用 MTA スレッドからの直接 COM 呼び出しにより PowerShell プロセス起動を排除 — `getFocusedElement` は **2ms**（160 倍高速）、`getUiElements` はバッチ型 BFS アルゴリズムでクロスプロセス RPC を最小化し **約 100ms** で完了。画像差分は **SSE2 SIMD** で 13〜15 倍のスループット。ネイティブエンジンが利用不可の場合、全関数が PowerShell に透過フォールバック — 設定不要。
- **🎯 Set-of-Marks (SoM) ビジュアルフォールバック** — ゲーム・RDP・非対応 Electron アプリで UIA が完全に機能しない場合でも、`screenshot(detail="text")` が Hybrid Non-CDP パイプラインを自動起動。Rust 画像前処理 → Windows OCR → クラスタリング → 赤い枠線 + 番号バッジ（`[1]`、`[2]`…）付き PNG 画像を生成し、`clickAt` 座標付きの要素リストを返します。CDP 不要。
- **🔁 視覚のみ対象での 1 コール確認** — UIA が効かない対象（Electron・PWA・ゲーム・自前描画キャンバス・RDP ウィンドウ）では、`desktop_act` が操作後の確認を応答自体に畳み込めます。成功時にオプションの `roiCapture` ——「変化した領域だけ」を切り出した PNG ＋ そこに今ある要素の lease なしプレビュー —— を同梱するので、別途 `desktop_state` ＋ `screenshot` を呼ばずに「クリックの結果」と「次の対象」を確認できます。視覚のみ対象では変化があれば**デフォルトで付与**されます（`returnCapture:"on-change"`）。`returnCapture:"never"` で抑止、`"always"` で常時付与。構造化対象（ブラウザ/CDP・UIA リッチなネイティブ）には付与されないため、それらの応答は不変です（そこは `desktop_state` の方が安価かつ正確）。
- **🔐 Key Locker — SSH / sudo のパスワードをターミナルが自動入力** — 認証情報はロッカー自身のセキュアダイアログに一度だけ入力して、この PC 上に暗号化保存（Windows DPAPI）— アシスタントには一切見えません。以後は `key_locker(action='launch_console')` で開いたコンソールで `ssh` / `sudo` を実行するだけで、隠しパスワードプロンプトに自動入力されます（既定では入力毎に確認あり）。詳細は [Key Locker](#key-locker-ターミナル認証情報の自動入力) 参照。
- **LLM ネイティブ設計** — 人間の操作を模倣するのではなく、「LLM がいかにコンテキストを消費せず高速に動けるか」を前提に設計。`run_macro` による複数操作の一括実行（API 往復の削減）と、**MPEG P-frame 方式のレイヤー差分** (`diffMode`) を組み合わせることで、無駄な画像転送や推論ループを極限まで削ぎ落とす。
- **Reactive Perception Graph** — ウィンドウやブラウザタブに `lensId` を登録し、以後の action tool に渡すだけで、操作前の安全 guard と操作後の `post.perception` フィードバックを受け取れます。`screenshot` / `desktop_state` の反復を減らし、別ウィンドウへの誤入力や古い座標クリックを防ぎます。
- **日本語/CJK 完全対応** — ウィンドウタイトル取得に Win32 `GetWindowTextW` を使用。nut-js の文字化けを回避。IME バイパス入力にも対応。
- **3 段階トークン削減** — `detail="image"`（~443 tok）/ `detail="text"`（~100-300 tok）/ `diffMode=true`（~160 tok）を用途に応じて使い分け。視覚確認が必要な時だけ画像を送る。
- **座標変換不要の 1:1 モード** — `dotByDot=true` で WebP 1:1 キャプチャ。画像上のピクセル座標 = 画面座標なのでスケール計算が不要。
- **ブラウザキャプチャのデータ削減** — `grayscale=true`、`dotByDotMaxDimension=1280`、`windowTitle + region` の部分切り出しで、ブラウザ chrome や不要な余白を除外。重いキャプチャで 50〜70% 程度の削減を狙えます。
- **UIA アクション要素抽出** — `detail="text"` でボタン・入力欄の名前と `clickAt` 座標を JSON で返すため、画像を見なくても操作できる。
- **Chromium スマートフォールバック** — Chrome/Edge/Brave に対して `detail="text"` を使うと、低速な UIA を自動スキップし Windows OCR を実行。`hints.chromiumGuard` + `hints.ocrFallbackFired` で経路を判別可能。
- **CLI 自動ドック** — `window_dock(action='dock')` でウィンドウを画面隅にスナップ＆最前面固定。`DESKTOP_TOUCH_DOCK_TITLE='@parent'` を設定すると、MCP 起動時にプロセスツリーを辿って Claude CLI をホストするターミナルを自動ドック。
- **緊急停止 (Failsafe)** — マウスを**画面左上コーナー (0,0 付近 10px)** に移動すると MCP サーバーが即座に終了。

---

## 前提環境

| 項目 | 要件 |
|---|---|
| OS | Windows 10 / 11 (64-bit) |
| Node.js | v20 以上推奨 (v22+ で動作確認済み) |
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

npm ランチャーは npm package version に厳密に対応する runtime だけを取得します。`X.Y.Z` を実行した場合は GitHub Release `vX.Y.Z` のみを参照し、`desktop-touch-mcp-windows.zip` をダウンロードして SHA256 を検証できた場合にだけ `%USERPROFILE%\.desktop-touch-mcp` へ展開します。検証済みキャッシュは次回以降も再利用されます。

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
| `terminal(action='run')` | コマンド送信 → 完了待ち → 出力取得を 1 コールで実行。完了判定は `until`: `quiet` / `pattern` / `exit`（コマンドの**終了**を待ち exit code を返す → [ターミナルの完了判定](#ターミナルの完了判定-until)） |
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

リカバリ — `response.attention` を毎観測でチェック、`desktop_discover` / `desktop_act` の `response.warnings[]` を読む:

- `lease_expired` / `lease_generation_mismatch` / `lease_digest_mismatch` / `entity_not_found` → `desktop_discover` を再実行
- `modal_blocking` → `response.blockingElement` (含まれていれば) がブロック中の modal を識別する。`click_element(name=blockingElement.name)` で閉じてからリトライ
- `entity_outside_viewport` → `scroll(action='to_element' | 'raw')` 後に `desktop_discover` 再実行
- `executor_failed` → V1 (`click_element` / `mouse_click` / `browser_click`) にフォールバック

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
- Windows 専用。機能全体の無効化は `DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1`。セキュアダイアログは未署名の実行ファイルのため、初回起動時に Windows SmartScreen の「発行元不明」警告が出ることがあります（[前提環境](#前提環境)の注意参照）。

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

**マウスを画面の左上コーナー (座標 0,0 付近 10px 以内) に素早く移動させると MCP サーバーが即座に停止します。**

- **ツール実行前チェック**: 各ツール呼び出しの開始時に毎回確認
- **バックグラウンド監視**: 500ms 間隔で常時監視（長時間処理中のバックアップ）
- コーナー判定範囲: 10px 以内

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

---

## UI オペレーティングレイヤー (V2)

> **ステータス: v0.17 からデフォルト ON。** `desktop_discover` / `desktop_act` はインストール直後から使えます。

V2 は、座標ベースのクリックをエンティティベースの操作に置き換える 2 つの新ツールを追加します。

| ツール | 説明 |
|---|---|
| `desktop_discover` | ウィンドウまたはブラウザタブを観測し、インタラクティブなエンティティを返します。raw 座標は返しません。UIA（ネイティブ）、CDP（ブラウザ）、ターミナル、GPU ビジュアルレーンに対応。 |
| `desktop_act` | `desktop_discover` が返したエンティティを操作します。実行前にリースを検証し、セマンティック diff（`entity_disappeared`、`modal_appeared`、`focus_shifted` など）を返します。視覚のみの対象では、成功時に `roiCapture`（変化領域の PNG ＋ 次対象の lease なしプレビュー）を同梱でき、「結果確認」と「次対象探索」を 1 コールで完了できます（`returnCapture`: `on-change` 既定で変化時に付与 / `never` で抑止 / `always` で常時）。 |

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

### 削除済み: `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2`

v0.16.x での opt-in フラグです。v0.17 以降は V2 がデフォルト ON のため、このフラグは効果を持たず、設定から削除して問題ありません。V2 を無効化するには `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` を設定してください。

### V2 が失敗した場合のリカバリ

`desktop_act` が `ok: false` を返した場合は `reason` を確認し、ツール説明のリカバリヒントに従ってください。よくあるパターン:

- `lease_expired` / `*_mismatch` / `entity_not_found` → `desktop_discover` を再実行してリースを更新
- `modal_blocking` → `response.blockingElement` (含まれていれば) が `{ name, role, automationId? }` を返す。`click_element(name=blockingElement.name)` でモーダルを閉じてから retry
- `entity_outside_viewport` → `scroll` / `scroll(action='to_element')` してから `desktop_discover` を再実行
- `executor_failed` → `click_element` / `mouse_click` / `browser_click` にフォールバック

`desktop_discover` が warnings（`visual_provider_unavailable`、`visual_provider_warming`、`cdp_provider_failed` 等）を返した場合も、V1 ツール（`screenshot`、`click_element`、`get_ui_elements`、`terminal(action='send')` など）がエスケープハッチとして使えます。

---

## 既知の制限

| 制限 | 詳細 | 回避策 |
|---|---|---|
| ゲーム・動画プレイヤーの背面キャプチャが黒またはハング | DirectX フルスクリーン等は `PW_RENDERFULLCONTENT (flag=2)` でも再描画してくれないことがある。v1.4.4 以降、window-targeted `screenshot(detail='image')` は PrintWindow が何も返さない場合と all-black + zero-variance フレームを返した場合に BitBlt fallback へ自動で切り替わるが、PrintWindow がハングするケースは fallback されない | `screenshot({mode:'background', fullContent:false})` で旧 PrintWindow フラグに切り替え。それでも黒なら default `mode='normal'` の BitBlt fallback が画面の rect を返す (`hints.captureFallbackReason: 'printwindow-all-black'` で識別可能) |
| UIA 呼び出しのオーバーヘッド | Rust ネイティブ: フォーカス取得 ~2ms、ツリー走査 ~100ms。PowerShell フォールバック: ~300ms | 操作前に `workspace_snapshot` で一括取得し、以降は `diffMode` で差分確認 |
| Chrome / WinUI3 の UIA 要素が空 | Chromium は UIA を限定的にしか公開しない | `browser_open` + `browser_locate` で DOM ベースのクリックを使用。視覚確認のみなら `screenshot(detail="image")` |
| レイヤーバッファの TTL | 90 秒操作なしでバッファが自動クリア → 次回 `diffMode` が I-frame になる | 長い待機後は `workspace_snapshot` で明示的にリセット |

---

## パフォーマンス (v0.15)

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

## 🚀 5,000+ Downloads!

おかげさまで5,000ダウンロードを突破しました！この実験的なツールを試し、
Issue や PR、バグ報告で貢献してくれたすべての方に感謝します。皆さんの声が
次のリリースをより良くしてくれました。一緒に育ててくれてありがとう！

---

## ライセンス

MIT

