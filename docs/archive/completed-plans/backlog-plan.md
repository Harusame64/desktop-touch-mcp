
### 📋 desktop-touch-mcp v0.15+ 改善バックログ

| ステータス | 機能・タスク名 | 何が問題だったか (Problem) | どう直すか (Solution) |
| :--- | :--- | :--- | :--- |
| 🚀 **Next** | **`browser_eval` のIIFE自動ラップ**<br>🔴 高優先度 | グローバルスコープで実行されるため`const first`/`const items`等が既存変数と衝突し`SyntaxError: Identifier has already been declared`が発生する（実使用で確認済み）。 | 実行前にスニペットをIIFE `(function(){ ... })()` で自動ラップする。先頭が`(function`または`(async function`で始まっていなければ自動適用。ドキュメントにも「複雑なコードはIIFEで包むことを推奨」と追記。 |
| 🚀 **Next** | **`browser_launch` の `killExisting` オプション**<br>🔴 高優先度 | `--remote-debugging-port`なしで起動中のChromeがあると`browser_connect`が接続できず、手動で`Stop-Process -Name chrome -Force`が必要になる。 | `browser_launch`に`killExisting: boolean`オプションを追加。trueの場合、起動前に既存のChromeプロセスを終了してからデバッグポート付きで再起動する。 |
| 🚀 **Next** | **`wait_until` の `url_matches`** | ページ遷移やリダイレクトの完了を待機したい時、現状は`element_matches`等で無理やり代替しているが、意図と合致せず不安定。 | `wait_until`の条件に`url_matches`を追加し、現在のURLパターン（正規表現など）でクリーンに待機できるようにする。 |
| 🚀 **Next** | **`browser_get_dom` の失敗時ヒント強化**<br>🟡 中優先度 | セレクタが見つからないと`ElementNotFound`で終わるだけで、実際のページ構造が分からず次のアクションを立てにくい。 | 失敗時の`suggest[]`配列に`document.body`直下の主要タグ・クラス名を数件（最大5件程度）追加し、LLMが代替セレクタを推測しやすくする。 |
| 🚀 **Next** | **Scroll + OCR 統合ツール** | 長文ドキュメントを読む際、LLMが「スクロール→キャプチャ→OCR」をループで回すのは非効率で、重複行の除去もLLM側では失敗しやすい。 | ページ単位でスクロールしながらOCRを実行し、重複行の除去やページ末尾の判定までをサーバー側で完結させてクリーンなテキストを返す専用ツールを作る。 |
| 🏗️ **将来構想** | **ブラウザの非CDP操作支援** | CDP接続がないChromeと通常のウィンドウ操作が混ざると、LLMが「このChromeはDOM操作できるのか？」を判別しづらい。 | CDPの有無を自動判別し、未接続でもUIAや画像認識へのフォールバックをよしなに処理するハイブリッドな操作支援レイヤーを構築する。 |
| 🏗️ **将来構想** | **高レベル統合ツールの追加**<br>（ツール数削減）🟡 中優先度 | 58ツールあり選択コストが高い。LLMが基本ツールを組み合わせるオーバーヘッドも大きい。 | よく使うフローをまとめた高レベルツールを検討: `browser_wait_for_content`（特定テキスト/要素が現れるまで待機）、`browser_scroll_and_find`（スクロールしながら要素を探す）など。 |
| 🏗️ **将来構想** | **長時間タスク完了通知のガイドライン**<br>🟢 低優先度 | `notification_show`で離席中でもタスク完了に気づけるが、LLMが明示的に呼ぶ必要があり忘れがち。 | ドキュメントやシステムプロンプトに「5分以上かかるタスク完了時は`notification_show`を呼ぶ」ガイドラインを追加。将来的にはツール側で自動通知オプションも検討。 |
| 🏗️ **将来構想** | **画像処理の完全Rust化**<br>（脱 `sharp`） | `sharp`は非常に高速だが巨大なネイティブ依存を生む。将来的に4K等の高解像度環境でより効率的な処理が求められる可能性がある。 | リサイズ・グレースケール・クロップをRust側に引き取り、SIMD (AVX2/SSE2 の Dynamic Dispatch) とマルチスレッドで完結する最強のパイプラインを構築する。 |
| 🎉 **完了** | **安定した対象指定**<br>(`@active` / `hwnd`) | Chromeのタブ切り替えやYouTubeの動画遷移でタイトルが動的に変わり、`windowTitle`指定だと操作対象を見失いやすい。毎回タイトルを指定するのも手間。 | **【実装済み】** `resolveWindowTarget` を実装し、keyboard/mouse/perception 等の全ツールで`hwnd`直接指定と`"@active"`ショートカットに対応 (commit `ca764c2`)。 |
| 🎉 **完了** | **`browser_fill_input` のスコープ指定** | 現代のWebアプリはDOMの先頭（ヘッダー等）にグローバル検索バーがあることが多く、LLMが緩いセレクタでフォーム入力しようとすると高確率で検索バーに誤爆する。 | **【実装済み】** `scope`パラメータを追加。`document.querySelector(scope).querySelector(selector)`のように探索範囲を特定の親要素内に限定できる。 |
| 🎉 **完了** | **座標系の明示**<br>（UX改善） | screen / window-local / image のどの座標系が返ってきているのか、LLMがログを読んだ際に一瞬迷ってしまう。 | **【実装済み】** `screenshot.ts`のスキーマ説明・ツール詳細に`window-local coordinates`/`screen_x = origin_x + image_x`等の座標系アノテーションを明記。`clickAt`レスポンスにも系が明示されている。 |
| 🎉 **完了** | **`browser_get_form` ツール** | フォーム内の構造（name, type, 隠しフィールド等）を事前に把握できず、LLMが`browser_eval`で手探りする必要があった。 | CDP経由で指定フォーム内の全入力フィールドの属性や初期値を一括取得し、JSONで返す専用ツールを追加。 |
| 🎉 **完了** | **CDPベースのスクロールツール** | マウスホイールエミュレーションの`scroll`だと、Webページ内のネストした要素にスクロールイベントが届きにくい。 | **【既存ツールで解決済み】** `scroll_to_element` と `smart_scroll` で要件を満たしているため、LLM側にツールの存在を再学習させてクローズ。 |
