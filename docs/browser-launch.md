# browser_launch: CDP デバッグモード Chrome/Edge/Brave の自動起動

## 目的

CDP 系ツール（`browser_connect` / `browser_find_element` / `browser_click_element` / `browser_eval` / `browser_get_dom` / `browser_navigate`）を使うには、Chrome/Edge を `--remote-debugging-port` 付きで起動する必要がある。

`browser_launch` はこの起動を LLM 側から行えるようにし、CDP エンドポイントが準備完了になるまで待機する。

## 動作

| 呼び出し | 結果 |
|---|---|
| `browser_launch()` | Chrome → Edge → Brave の順で最初にインストール済みのブラウザを起動 |
| `browser_launch(browser='edge')` | Edge を指定起動 |
| `browser_launch(url='https://...')` | 起動直後に URL を開く（CLI 引数として渡す） |
| `browser_launch(port=9333)` | 指定ポートで CDP を開く |
| 既にポートが生きている場合 | 再 spawn せず即 return（冪等） |

## レスポンス

```json
{
  "port": 9222,
  "alreadyRunning": false,
  "launched": { "browser": "chrome", "path": "C:\\...", "userDataDir": "C:\\tmp\\cdp" },
  "tabs": [{ "id": "...", "title": "...", "url": "..." }]
}
```

`alreadyRunning: true` の場合は `launched: null`。

## CDP ポートの設定ファイル変更

デフォルトポート（9222）を変更する場合は `desktop-touch-config.json` を作成する。

検索順（最初に見つかったファイルが使われる）：
1. 環境変数 `DESKTOP_TOUCH_CONFIG` で指定したパス
2. `~/.claude/desktop-touch-config.json`
3. サーバースクリプトディレクトリ直下の `desktop-touch-config.json`

```json
{
  "cdpPort": 9333
}
```

設定はサーバー起動時に一度読み込まれる。変更後は MCP サーバーを再起動する。

## 実装箇所

- `src/tools/browser.ts` — `browserLaunchSchema` / `browserLaunchHandler` / 登録
- `src/utils/launch.ts` — `resolveWellKnownPath` / `spawnDetached`（workspace.ts から抽出）
- `src/utils/desktop-config.ts` — `getCdpPort()` による設定ファイル読み込み
- `src/index.ts` — instructions の CDP setup 節を更新

## カバー範囲

- Chrome / Edge / Brave: ✅ WELL_KNOWN_PATHS に全パス候補あり
- 冪等動作: ✅ 既に CDP が上がっていれば spawn しない
- url パラメータ: ✅ CLI positional arg として渡す（navigateTo の race を回避）
- `run_macro` 経由: ✅ `browserLaunchHandler` を直接再利用
