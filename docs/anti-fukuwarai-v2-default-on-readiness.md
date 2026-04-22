# Anti-Fukuwarai v2 — Default-On Readiness & Rollback Policy

作成: 2026-04-22  
フェーズ: Phase 4 / Batch P4-B  
ブランチ: `desktop-touch-mcp-fukuwaraiv2`

---

## 1. Current Decision

**Decision: opt-in 継続 / default-on 見送り**

理由:

- P4-A review で P1 が 2 件残存している（後述 §2）
- rollback を簡単に保つことが Phase 4 の判断原則
- dogfooding 実録がまだ薄い

P4-B の推奨判断: **選択肢 1 — opt-in 継続 + docs 推奨 + dogfood 継続**

P2 も 2 件残存しているが default-on ブロッカーではなく、optional gate として §9 (G4/G5) に整理している。

---

## 2. Why Not Default-On Yet

### P1-1. `desktop_touch` production wiring に modal / viewport / focus 観測が未接続

`TouchEnvironment` の `isModalBlocking`、`isInViewport`、`getFocusedEntityId` が production facade では
デフォルト値のまま（`() => false` / `() => true`）。

影響:

- modal blocking: facade では常に pass → modal 越しに誤操作する可能性
- viewport check: facade では常に pass → スクロール外の要素へ誤操作する可能性
- focus steal 検知: 未接続

実装位置: `src/engine/world-graph/session-registry.ts` の `TouchEnvironment`

### P1-2. terminal executor が foreground path で focus を奪う

`src/tools/desktop-executor.ts` の terminal send が `restoreAndFocusWindow()` + `keyboard.type()` を使用。  
LLM が他のウィンドウを操作しながら terminal command を送ると focus を奪うリスクがある。

---

## 3. Activation Policy

### 現行 — Flag-gated opt-in

```
DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1
```

| フラグ状態 | V2 tools (desktop_see / desktop_touch) | V1 tools (56 ツール) |
|---|---|---|
| 設定なし (default) | 公開されない | 常時公開 |
| `=1` | 公開される | 常時公開 |
| その他の値 | 公開されない | 常時公開 |

実装位置: `src/server-windows.ts:46` の top-level dynamic import guard

```ts
const _desktopV2 = process.env.DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2 === "1"
  ? await import("./tools/desktop-register.js")...
  : null;
```

フラグが `1` でない場合: dynamic import は行われず zero side-effects。

### 将来候補 — Default-like preference (未実装)

```
DESKTOP_TOUCH_PREFER_FUKUWARAI_V2=1   # P4-B 時点では実装しない
```

このフラグは、default-on readiness が確認された後に設計・実装を検討する。  
**P4-B ではコードに追加しない。**

---

## 4. Kill Switch

**Kill switch: フラグを外してサーバーを再起動する（コード変更不要）**

```bash
# MCP 設定 (claude_desktop_config.json または .mcp.json) の env ブロックから
# DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1 を削除する

# サーバーを再起動する (Claude Desktop / npx コマンドを再実行)
```

フラグを外した後の状態:

- `desktop_see` / `desktop_touch` が MCP tool catalog から消える（Claude の tool list に出ない）
- V1 tools は引き続き全機能で動作する
- 進行中の leases / sessions はプロセス再起動で自動消去される

---

## 5. Rollback Path

V2 を有効にしていたセッションから V1 に戻る手順:

1. MCP 設定から `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` を削除する
2. サーバーを再起動する
3. V1 tools (`screenshot`, `click_element`, `get_ui_elements`, `get_context` など) で通常運用を再開する

V1 → V2 → V1 のサイクルは何度でも繰り返せる。  
V2 使用中に蓄積した session データ（leases）はプロセス内メモリのみで、再起動で消去される。  
設定ファイルや永続ストレージへの書き込みは V2 では行っていないため、手動クリアは不要。

---

## 6. Legacy Tools as Escape Hatch

V1 ツール群（56 tools）は以下の役割で当面残す。削除しない。

| 役割 | 説明 |
|---|---|
| **Migration path** | V2 で不安定な操作を V1 で補完する |
| **Debug path** | V2 の fail reason を V1 ツールで確認・診断する |
| **Escape hatch** | V2 が期待通りに動かない場合の即時 fallback |

**削除時期**: V2 が default-on として安定稼働し、全シナリオで V1 以上の信頼性が確認されるまで削除しない。

---

## 7. Fallback UX

### 7.1. desktop_see — warnings への対応

`response.warnings[]` にコードが返ってきた場合の推奨アクション:

| warning | 意味 | 推奨アクション |
|---|---|---|
| `no_provider_matched` | target 未指定かつ foreground window 解決失敗（Win32 API 一時失敗を含む） | `target.windowTitle` または `target.hwnd` を明示して再呼び出し。一時的な API 失敗の可能性もあるため短時間後にリトライ。V1 `screenshot(detail='meta')` で状態確認 |
| `partial_results_only` | primary provider が 0 件、additive provider が補完 | entity 数が少ない可能性。V1 `get_ui_elements` と比較して判断 |
| `cdp_provider_failed` | Chrome/Edge の CDP 接続失敗 | ブラウザが `--remote-debugging-port=9222` 付きで起動しているか確認。V1 `browser_*` tools で代替 |
| `visual_provider_unavailable` | GPU 視覚認識が未準備または失敗 | 初回呼び出し直後の場合はリトライ。structured lane (uia/cdp) の結果だけで続行可能 |
| `uia_provider_failed` | UIA プロバイダーが失敗 | V1 `get_ui_elements` / `click_element` で代替 |
| `terminal_provider_failed` | terminal プロバイダーが失敗 | V1 `terminal_read` / `terminal_send` で代替 |

### 7.2. desktop_touch — fail reason への対応

`ok=false` の場合は `reason` を確認して以下に従う:

| reason | 意味 | 推奨アクション |
|---|---|---|
| `lease_expired` | Lease の TTL 切れ | `desktop_see` を再呼び出しして新しい lease を取得 |
| `lease_generation_mismatch` | View が古い（UI が更新された） | `desktop_see` を再呼び出し |
| `lease_digest_mismatch` | entity の evidence digest が lease 発行時から変化（内容変化） | `desktop_see` を再呼び出し |
| `entity_not_found` | entity がレジストリにない（session 期限切れ or 無効な viewId） | `desktop_see` を再呼び出し |
| `modal_blocking` | モーダルダイアログが blocking | 先に V1 `click_element` でモーダルを閉じてから再試行 |
| `entity_outside_viewport` | entity がビューポート外 | V1 `scroll` / `scroll_to_element` で要素を表示してから再試行 |
| `executor_failed` | 実行エンジン (UIA/CDP/mouse) が失敗 | V1 ツールで直接操作（例: `mouse_click`, `click_element`, `browser_click_element`） |

---

## 8. Migration / Dogfooding Plan

| ステージ | 状態 | 内容 |
|---|---|---|
| S1. Experimental opt-in | ✅ 完了 | `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` で使える状態 |
| S2. Dogfood 実録 | 🔄 進行中 | 3-5 シナリオの実録ログを docs に追加する |
| S3. P1 解消 | ❌ 未着手 | modal/viewport/focus wiring + terminal background path |
| S4. Default-on 判断 | ❌ 未着手 | Gate 通過後に再評価 |
| S5. Release planning | ❌ 未着手 | P4-C へ進む |

---

## 9. Next Gates Before Default-On

default-on 判断を再開するための前提条件（gate）。すべて ❌ Open の状態:

| Gate | 優先 | 状態 | 説明 |
|---|---|---|---|
| G1. P1-1 解消 | 必須 | ❌ Open | `desktop_touch` production facade に modal / viewport / focus wiring を接続する |
| G2. P1-2 解消 | 必須 | ❌ Open | terminal executor を background/WM_CHAR 系 path に切り替える |
| G3. Dogfood 実録 | 推奨 | ❌ Open | 3-5 シナリオの実録ログを docs に追加する |
| G4. P2-1 対処 | optional | 🟡 Optional | facade init の async 化、または first-call retry 追加 |
| G5. P2-2 対処 | optional | 🟡 Optional | `TargetSpec` に `cdpPort` を追加 |

G1・G2 は default-on の必須条件。G3 は推奨。G4・G5 は optional。

---

## 10. Recommended Next Action

P4-B 完了後の推奨アクション順:

1. **Gate G1 着手**: `src/tools/desktop-executor.ts` + `session-registry.ts` に production modal/viewport/focus guard を配線する
2. **Gate G2 着手**: terminal executor を background send path に切り替える
3. **Gate G3 着手**: 実録ログを docs に追加する（`docs/anti-fukuwarai-v2-dogfood-log.md` など）
4. **全 gate 通過後**: P4-C (Release Planning) へ進む

P4-C への進行条件: G1 + G2 が両方 ✅ であること。

---

## 11. 関連ドキュメント

- [anti-fukuwarai-v2-experimental-quality-review.md](anti-fukuwarai-v2-experimental-quality-review.md) — P4-A review 結果
- [anti-fukuwarai-v2-phase4-instructions.md](anti-fukuwarai-v2-phase4-instructions.md) — Phase 4 指示書
- [Anti-Fukuwarai-V2.md](Anti-Fukuwarai-V2.md) — 設計書
- [release-process.md](release-process.md) — リリース手順
