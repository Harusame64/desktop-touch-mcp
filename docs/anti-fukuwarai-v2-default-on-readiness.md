# Anti-Fukuwarai v2 — Default-On Readiness & Rollback Policy

作成: 2026-04-22  
更新: 2026-04-23 (P4-E Batch A)  
フェーズ: Phase 4 / Batch P4-B → P4-E  
ブランチ: `desktop-touch-mcp-fukuwaraiv2`

---

## 1. Current Decision

**P4-B 判断: opt-in 継続 / default-on 見送り**（当時）

理由:

- P4-A review で P1 が 2 件残存している（後述 §2）
- rollback を簡単に保つことが Phase 4 の判断原則
- dogfooding 実録がまだ薄い

P4-B の推奨判断: **選択肢 1 — opt-in 継続 + docs 推奨 + dogfood 継続**

P2 も 2 件残存しているが default-on ブロッカーではなく、optional gate として §9 (G4/G5) に整理している。

**P4-E Batch A 更新（2026-04-23）:**

- G1 / G2 は解消済み（P4-C / ship decision memo 参照）
- Activation Policy: **Option A（disable flag 方式）を採択**（詳細 §3 更新参照）
- G3（dogfood 実録）を **required** に格上げ
- G4（visual attach race）を **必須** に格上げ
- G5（cdpPort）を **deferred** に降格

---

## 2. Why Not Default-On Yet（P4-B 時点の記録）

> **※ P4-C で解消済み。** P1-1 → G1 ✅、P1-2 → G2 ✅（§9 参照）。以下は経緯として残す。

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

### v0.16.x — Flag-gated opt-in（現行）

```
DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1
```

| フラグ状態 | V2 tools (desktop_see / desktop_touch) | V1 tools |
|---|---|---|
| 設定なし (default) | 公開されない | 常時公開 |
| `=1` | 公開される | 常時公開 |
| その他の値 | 公開されない | 常時公開 |

### v0.17.0 — Default-on + Disable flag（P4-E Batch A 決定: Option A）

**決定: `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` を kill switch として使う。**

詳細仕様・理由・env matrix: [`anti-fukuwarai-v2-activation-policy.md`](anti-fukuwarai-v2-activation-policy.md)

v0.17 優先順位（明文化）:
```
優先順位: DISABLE=1 > ENABLE=1 > default(ON)
```

| DISABLE | ENABLE | v2 状態 |
|---|---|---|
| 未設定 / 非"1" | 未設定 / 非"1" | **ON**（default-on） |
| 未設定 / 非"1" | "1" | ON（ENABLE は deprecated 互換） |
| "1" | 未設定 / 非"1" | **OFF** |
| "1" | "1" | **OFF**（DISABLE wins） |

実装変更は Batch B で実施（今回は docs のみ）。

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
| `visual_provider_unavailable` | GPU backend が未 attach | 初回呼び出し直後の場合はリトライ（G4 retry が対処）。structured lane (uia/cdp) の結果だけで続行可能 |
| `visual_provider_warming` | GPU backend は attach 済みだが warm 前 | 200-500ms 後に retry / structured lane で継続。G4 retry の対象（`unavailable` と同様に扱う） |
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
| S1. Experimental opt-in | ✅ 完了 | `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` で opt-in、v0.16.0 ship 決定（P4-D） |
| S2. G1/G2 解消 | ✅ 完了 | modal/viewport/focus wiring + WM_CHAR background path（P4-C） |
| S3. Policy 設計 | ✅ 完了 | activation / coexistence / dogfood 合格ライン（P4-E Batch A） |
| S4. Batch B 実装 | ✅ 完了（2026-04-23） | DISABLE flag 実装、visual attach retry（G4）、README 更新 |
| S5. Dogfood 実録 | 🔄 待機中 | 5 シナリオ実録 + 合格ライン 5 点チェック（G3）— ユーザー実施待ち |
| S6. Default-on 最終判断 | ❌ No-Go（2026-04-23） | 合格ライン 1 未達。詳細: [v17-final-decision-memo.md](anti-fukuwarai-v2-v17-final-decision-memo.md) |

---

## 9. Next Gates Before Default-On

default-on 判断を再開するための前提条件（gate）。すべて ❌ Open の状態:

| Gate | 優先 | 状態 | 説明 |
|---|---|---|---|
| G1. P1-1 解消 | 必須 | ✅ 閉 | production facade に modal / viewport / focus wiring 配線済み（P4-C） |
| G2. P1-2 解消 | 必須 | ✅ 閉 | terminal executor を WM_CHAR background path に切替済み（P4-C） |
| G3. Dogfood 実録 | **必須** | ❌ Open | 5 シナリオの実録ログ（合格ライン 5 点）— [`anti-fukuwarai-v2-dogfood-log.md`](anti-fukuwarai-v2-dogfood-log.md) |
| G4. visual attach race 対処 | **必須** | ✅ 閉 | `visual_provider_unavailable` / `visual_provider_warming` 時に 200ms × 1 回 retry 実装済み（Batch B） |
| G5. cdpPort 対応 | deferred | 🔵 Deferred | `TargetSpec.cdpPort` 追加は default-on 後に要望ベースで実施 |

G1・G2・G4 は解消済み。G3（dogfood 5 シナリオ実録・合格ライン 5 点）が残る必須 gate。G5 は deferred。

---

## 10. Recommended Next Action

**P4-E Batch A 完了後の推奨アクション順:**

| Batch | 内容 | 状態 |
|---|---|---|
| **Batch A** | Activation / rollback / coexistence policy を docs に落とす | ✅ 完了（2026-04-23） |
| **Batch B** | `DISABLE` flag 実装・visual attach retry（G4）・server instructions / README 更新 | ✅ 完了（2026-04-23） |
| **Batch C** | Tier 1 技術的暫定 Go 確認・dogfood 手順書整備 / Tier 2 ユーザー実録（5 シナリオ）・最終判断 | 🔄 Tier 1 ✅ / Tier 2 待機中 |

**default-on 再判定ライン:**
- Tier 1（技術的暫定 Go）: T1-T7 全 ✅ → **達成済み（2026-04-23）**
- Tier 2（dogfood 最終 Go）: 合格ライン 5 点満たす → v0.17.0 release 実行可
- Tier 2 未達 → v0.16.x patch で dogfood 継続、不足シナリオを追記

詳細: [`anti-fukuwarai-v2-batch-c-tier1-review.md`](anti-fukuwarai-v2-batch-c-tier1-review.md)  
実録: [`anti-fukuwarai-v2-dogfood-log.md`](anti-fukuwarai-v2-dogfood-log.md)

---

## 11. 関連ドキュメント

- [anti-fukuwarai-v2-experimental-quality-review.md](anti-fukuwarai-v2-experimental-quality-review.md) — P4-A review 結果
- [anti-fukuwarai-v2-phase4-instructions.md](anti-fukuwarai-v2-phase4-instructions.md) — Phase 4 指示書
- [Anti-Fukuwarai-V2.md](Anti-Fukuwarai-V2.md) — 設計書
- [release-process.md](release-process.md) — リリース手順
