# Anti-Fukuwarai v2 — V1 / V2 Coexistence Policy

作成: 2026-04-23  
フェーズ: P4-E / Batch A

---

## 1. 基本方針

V1 tools（`mouse_click`, `click_element`, `browser_click_element` 等）は **escape hatch として削除しない**。

V2 tools（`desktop_see` / `desktop_touch`）は default-on 後も V1 の上位互換ではなく、**entity-based の第一候補**として位置付ける。LLM は V2 を優先し、V2 が失敗した場合のみ V1 に fallback する。

---

## 2. Clicking Priority Order

| Priority | Tool | 対象 | 条件 |
|---|---|---|---|
| 1 | `browser_click_element(selector)` | Chrome / Edge | CDP が有効（`--remote-debugging-port=9222`） |
| 2 | `desktop_touch(lease)` | native / dialog / visual | `desktop_see` で entity を取得済み |
| 3 | `click_element(name / automationId)` | native Windows | `desktop_touch` が `ok:false` |
| 4 | `mouse_click(x, y)` | 全対象 | 上記が全て不可の最終 escape |

**V2 を Priority 2 に置く理由:**
- entity + lease による pre-flight check（modal / viewport / focus guard）でデタラメなクリックを防ぐ
- `desktop_touch` は fail reason を返すため、LLM が次の手を決定しやすい
- `click_element` はマッチングが名前ベースで脆く、visual-only 対象には使えない

**CDP がある場合に Priority 1 が `browser_click_element` のままである理由:**
- ブラウザ内は CDP selector が最も安定（リペイントで座標がずれない）
- `desktop_touch` も browser lane を持つが、CDP direct の方が round-trip が少ない

---

## 3. V2 fail 時の V1 Fallback 対応表

`desktop_touch` が `ok: false` を返した場合の対処:

| reason | 意味 | 推奨 fallback |
|---|---|---|
| `lease_expired` | lease の有効期限切れ | `desktop_see` を再実行して lease を更新 |
| `lease_generation_mismatch` | UI が更新されて entity が変わった | `desktop_see` を再実行 |
| `lease_digest_mismatch` | entity の内容が変わった | `desktop_see` を再実行 |
| `entity_not_found` | entity が消えた | `desktop_see` を再実行して確認 |
| `modal_blocking` | モーダルが出ている | `click_element` でモーダルを先に処理してから retry |
| `entity_outside_viewport` | entity が画面外 | `scroll` / `scroll_to_element` してから `desktop_see` → retry |
| `executor_failed` | 実行レイヤーのエラー | `click_element` / `mouse_click` / `browser_click_element` に fallback |

`desktop_see` が `warnings[]` を返した場合:
- `no_provider_matched` → `target.windowTitle` を追加するか retry
- `partial_results_only` → V1 `get_ui_elements` と比較して補完
- `cdp_provider_failed` → `--remote-debugging-port=9222` を確認
- `visual_provider_unavailable` → retry（初回 attach の race）または structured lane で継続
- `uia_provider_failed` / `terminal_provider_failed` → V1 tools で代替

---

## 4. Server Instructions への追記ドラフト（Batch B 向け）

default-on 後の server instructions に以下を追加する（Batch B で実装）:

```
## Clicking — priority order (V2 enabled)
1. browser_click_element(selector) — Chrome/Edge (CDP, stable across repaints)
2. desktop_touch(lease) — native/dialog/visual (entity-based, use after desktop_see)
3. click_element(name or automationId) — native fallback if desktop_touch ok=false
4. mouse_click(x, y, origin?, scale?) — pixel last resort; coords from dotByDot only

## When desktop_touch returns ok:false
Read `reason` and follow the recovery path:
- lease_expired / lease_generation_mismatch / lease_digest_mismatch / entity_not_found
  → re-call desktop_see to get a fresh lease
- modal_blocking → dismiss modal via click_element, then retry
- entity_outside_viewport → scroll via scroll/scroll_to_element, then re-call desktop_see
- executor_failed → fall back to click_element / mouse_click / browser_click_element
```

---

## 5. Tool Description への追記ドラフト（Batch B 向け）

`desktop_see` の description に追加:
```
If response.warnings[] is non-empty, results may be partial.
Recovery: no_provider_matched → add target.windowTitle or retry;
partial_results_only → compare with V1 get_ui_elements;
cdp_provider_failed → check --remote-debugging-port=9222;
visual_provider_unavailable → retry once (first-call race) or continue with structured lane;
uia/terminal_provider_failed → use V1 tools (get_ui_elements / terminal_read).
```

`desktop_touch` の description に追加:
```
If ok=false, read 'reason':
  lease_expired / lease_generation_mismatch / lease_digest_mismatch / entity_not_found → re-call desktop_see;
  modal_blocking → dismiss modal via V1 click_element then retry;
  entity_outside_viewport → scroll via V1 scroll/scroll_to_element then retry;
  executor_failed → fall back to V1 tools (click_element / mouse_click / browser_click_element).
```

---

## 6. V1 Tools の Deprecation Schedule

| フェーズ | V1 状態 |
|---|---|
| v0.16.x | 全て有効・推奨（V2 は opt-in experimental） |
| v0.17.x | 全て有効（escape hatch として継続）。Priority order は V2 優先 |
| v0.18.x | 要議論：dogfood 30+ sessions で V2 coverage が確認できれば expert surface に移動を検討 |
| v0.19.0+ | V1 の一部を `[legacy]` prefix 付きで 1 minor 周知 → 削除。ただし `browser_click_element` / `terminal_send` / `screenshot` 等は V2 と非重複なので維持 |

**削除候補（将来）:** `click_element`, `mouse_click`, `get_ui_elements`, `set_element_value`  
**削除しない（永続）:** `browser_*`, `terminal_*`, `screenshot`, `keyboard_*`, `scroll`, `perception_*`, `get_context`

---

## 7. Default-On 後も V1 を Catalog に残す理由

1. **Migration path**: V2 不安定時の V1 補完
2. **Debug path**: V2 の fail reason を V1 で診断
3. **Escape hatch**: V2 が期待通り動かない場合の即時 fallback
4. **削除コスト > 残すコスト**: catalog から消しても MCP client の混乱が増えるだけ

削除するのは「V2 が全シナリオで V1 以上の信頼性」を dogfood で確認してから。
