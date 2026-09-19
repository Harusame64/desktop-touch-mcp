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
- `modal_blocking` → `response.blockingElement` (含まれていれば) がブロック中の modal を識別する。`role: "dialog"` は、別のダイアログ窓が対象の窓を無効にしていることを表す。`blockingElement.hwnd` がそのダイアログなので、`target.hwnd = blockingElement.hwnd` で `desktop_discover` し直して答えてからリトライ（`name` は題名で、空や他と同じことがある）。それ以外の role では `click_element(name=blockingElement.name)` で閉じてからリトライ
- `entity_outside_viewport` → 要素が画面外へ移動: `scroll(action='to_element' | 'raw')` 後に `desktop_discover` 再実行（窓ごと移動・閉じた場合は再 discover）
- `origin_window_not_visible` → 要素の由来ウィンドウが最小化 / 非表示で、発見時の座標には何も描画されていない: `focus_window(windowTitle)` で復元してから `desktop_discover` 再実行
- `coordinate_outside_reachable_bounds` → 座標がどのモニタ上にも無い。座標ベースのマウス入力（`mouse_click` / `mouse_drag` / `scroll` / `browser_click`、および `desktop_act` の mouse route）は**全モニタで動作する**ようになった（プライマリの左 / 上に置いたモニタを含む）ため、このエラーは通常「座標が古い」ことを意味する — 読み取った後にウィンドウが移動 / 閉じた場合。`desktop_discover` を再実行して新しい座標で操作する。サーバが内蔵の Windows 入力モジュール無しで動いている場合はプライマリモニタのみに fallback する（その旨がエラーメッセージに出る）。対処はウィンドウをプライマリへ移すか、サーバの再インストール
- `cursor_placement_blocked` → 座標はモニタ上にあるが、ポインタをそこへ置けなかったためクリックは送られていない。他のアプリがカーソルを自分のウィンドウ内に拘束している（全画面ゲームで多い）/ リモートデスクトップのセッションが切断・ロックされている / 他のプログラムがポインタを動かし続けている / モニタを着脱した直後、といった場合に起きる。カーソルを掴んでいるアプリから離れる、セッションに再接続する、モニタ構成を変えた場合は `desktop_discover` を取り直してから再試行する。カーソルを動かさない `click_element`（UIA invoke）はその間も使える
- `keyboard_target_unsafe` → 文字が指定した欄に届かないため `type` を拒否した。キーボードのフォーカスが別のコントロールか別のウィンドウにある、または受け取るコントロールが読み取り専用。何も入力されておらず、どれかは `if_unexpected.detail` に出る。別のコントロール / ウィンドウなら、指定した欄にフォーカスを移してから入力し直す。その道ごとの戻り方は `if_unexpected.detail` に出る。タイトルで指定したウィンドウなら同じ entity への `desktop_act`（`action='click'`）で移せる。ハンドルで指定したウィンドウでは、テキスト欄へフォーカスを移す道がまだ無いので、ウィンドウのタイトルで `desktop_discover` し直し、そこから欄をクリックする——ただし共通ダイアログ（名前を付けて保存・開く）はタイトルもハンドルに解決するので、その道は開かない。別のウィンドウのときは、まず欄のウィンドウを前面に出す（`focus_window`）: 最後に持っていたフォーカスのまま前へ出るうえ、フォーカスを持っているウィンドウはたいてい欄の上に描かれている。前面の `keyboard` で打ち直さないこと: フォーカスを持っているものが文字を受け取ってしまう
- `executor_failed` → V1 (`click_element` / `mouse_click` / `browser_click`) にフォールバック

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
