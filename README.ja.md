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
| OS | Windows 10 / 11 (64-bit)。**Apple Silicon の macOS 14 以降は機能を絞ったプレビュー（ツール4つのみ）** — [macOS（プレビュー）](#macosプレビュー) を参照 |
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

> **機能を絞ったプレビューです。** macOS 版のツールは4つだけで、Windows 版のごく一部です。挙動はリリースのあいだに変わることがあります。

Apple Silicon の Mac（macOS 14 以降）では、同じ `npx` で macOS 用のサーバーが起動します。使えるツールは `desktop_state`・`desktop_discover`・`desktop_act`（押す・文字の置き換え／追記）・`screenshot`（ウィンドウ1枚）の4つです。ほかのツールは Windows 専用で、macOS では一覧に出ません。

- サーバーを動かすアプリ（ターミナル、iTerm、VS Code、Claude アプリなど）に、システム設定 › プライバシーとセキュリティ で **アクセシビリティ** を、ウィンドウのタイトルとスクリーンショットには **画面収録** も許可してください。最近の macOS では名前が変わっていることがあります（macOS 27 では「デバイスの制御とデータへのアクセス」と「画面収録とシステムオーディオ録音」）。次のコマンドで、それぞれの画面を直接開けます:
  ```bash
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  ```
  許可したら、**MCP サーバーを再起動**してください（MCP クライアントで再起動・再接続するか、サーバーを動かしているアプリを再起動）。動いていたサーバーは、あとから付けたアクセシビリティの許可を見ませんでした。画面収録を許可してもスクリーンショットが失敗するときは、そのアプリを終了して開き直してください。許可がないあいだ、ツールは `PermissionRequired` と、何を許可すればよいかを返します。
- インストールは `npx` だけにしてください。ブラウザでダウンロードしたリリースの zip は Gatekeeper に拒否されます（ネイティブモジュールは公証していません）。
- stdio のみです（`--http` はまだ使えません）。Intel の Mac と Linux には対応していません。

---

## ツール一覧 (32 ツール)

> 📖 **詳細リファレンス**: [`docs/system-overview.md`](docs/system-overview.md) — 各ツールのパラメータ・応答形式・座標計算を網羅（英語）。

### 🌐 World-Graph V2（基本の経路）
| ツール | 概要 |
|---|---|
| `desktop_discover` | デスクトップを観察し、操作できる要素を lease 付きで返す（UIA・CDP・ターミナル・Visual SoM）。 |
| `desktop_act` | lease を確かめてから要素を操作する（クリック・入力・ドラッグ）。意味のある差分を返す。見た目でしか読めない対象では、変わった領域の PNG と次の候補の `roiCapture` も返す。 |

### 👁️ 観察・状態
| ツール | 概要 |
|---|---|
| `desktop_state` | フォーカス・前面ウィンドウ・カーソル・Auto-Perception の注意信号を軽く確かめる。 |
| `screenshot` | 複数のモードでキャプチャ：`detail='text'`（UIA/OCR）・`diffMode`（P-frame）・`dotByDot`（1:1）・`mode='background'`。画像は毎回インライン展開せず、保存した画像への安価なリンク `screenshot://by-ref/{id}` を返す。 |
| `screenshot_query` / `screenshot_gc` | by-ref リンクの裏にあるディスクキャッシュを見る・掃除する。`screenshot_query` はピクセルを読み直さずに一覧を返し、`screenshot_gc` は保持ポリシーで領域を空ける（既定は dry-run）。 |
| `workspace_snapshot` | 全ウィンドウのサムネイルと UI の要約を 1 回で取得し、作業の状況をつかむ。 |
| `server_status` | ネイティブエンジンの状態と、有効になっている機能を診断する。 |

### ⌨️ 入力・操作
| ツール | 概要 |
|---|---|
| `keyboard` | キー入力を送る。背面への入力（WM_CHAR）と、IME を避けるクリップボード経由に対応。 |
| `mouse_click` / `mouse_drag` | 座標でのクリック・ドラッグ。homing と forceFocus の保護つき。 |
| `scroll` | 複数の方式：`raw`（ノッチ）・`to_element`・`smart`（仮想リスト）・`capture`（スティッチ）。 |
| `click_element` | 名前/AutomationId で UIA 要素をクリックする旧来の方法（エンティティが取れないときの予備）。 |

### 🌐 Browser CDP（Chrome/Edge/Brave）
| ツール | 概要 |
|---|---|
| `browser_open` / `browser_navigate` | デバッグモードでの起動（何度呼んでも同じ結果）と、確実な遷移。 |
| `browser_click` / `browser_fill` / `browser_form` | 再描画やフレームワークの再レンダリングをまたいで安定する DOM 操作。 |
| `browser_eval` | `js`（スクリプト）・`dom`（HTML）・`appState`（SPA のデータ抽出）で中身を調べる。 |
| `browser_overview` / `browser_search` / `browser_locate` | 意味での一覧・grep のような DOM 検索・ピクセル単位の座標の取得。 |

### 🛠️ ユーティリティ・ワークフロー
| ツール | 概要 |
|---|---|
| `terminal` | コマンド実行の統合：`run`（送信＋完了待ち＋読み取り）・`read`（OCR/UIA）・`send`。`run` の完了判定は `quiet`・`pattern`・`exit`（コマンドの**終了**を待ち exit code を返す → [ターミナルの完了判定](docs/guide.ja.md#ターミナルの完了判定-until)）。 |
| `wait_until` | ウィンドウ・フォーカス・テキスト・URL の状態変化をサーバー側で効率よく待つ。 |
| `window_dock` / `focus_window` | ウィンドウ管理：`pin`（最前面固定）・`unpin`・`dock`（画面隅へ寄せる）・`focus`。 |
| `workspace_launch` | アプリを起動し、新しいウィンドウ（HWND）を自動で見つける（ローカライズされたタイトルにも対応）。 |
| `run_macro` | 最大 50 の操作を 1 往復にまとめて実行する。 |
| `clipboard` / `notification_show` | システムのテキストのやりとりと、利用者への通知。 |
| `key_locker` | ターミナルが自動入力する認証情報（SSH 鍵のパスフレーズ、sudo / ログインパスワード）を管理。秘密情報はロッカー自身のセキュアダイアログに一度だけ入力し、この PC 上で暗号化保存（Windows DPAPI）— アシスタントには一切見えない。`action='launch_console'` で自動入力対応コンソールを起動（返る `paneId` を `terminal` に渡して `ssh`/`sudo` を流す）、`save` / `list` / `forget` / `set_policy` / `status` で登録を管理。自動入力は `launch_console` で開いたコンソールでのみ発火。`DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1` で無効化。 |

### 📊 Office（Excel）
| ツール | 概要 |
|---|---|
| `excel` | Excel VBA マクロを COM 経由で記述・実行。`action='run_vba'` はマクロを管理下の Trusted Location に書き込んで実行、`action='check_access_vbom'` は読み取り専用の事前チェック。数式だけでは届かない処理を VBA で実行。初回のみ `node scripts/enable-access-vbom.mjs`。 |

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
