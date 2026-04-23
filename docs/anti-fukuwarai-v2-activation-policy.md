# Anti-Fukuwarai v2 — Activation Policy

作成: 2026-04-23  
フェーズ: P4-E / Batch A  
決定: Option A（disable flag 方式）

---

## 1. 決定事項

**v0.17.0 で default-on へ切替。kill switch は `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1`。**

これは P4-E Batch A での Opus レビューを経た決定。理由は §3 参照。

---

## 2. バージョン別 Env Matrix

| version | default 状態 | v2 を ON にするには | v2 を OFF にするには |
|---|---|---|---|
| v0.16.0 | OFF | `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` | 未設定（デフォルト OFF） |
| v0.16.x patch | OFF | 同上 | 同上 |
| **v0.17.0** | **ON** | 不要（default-on） | `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` |
| v0.17.x patch | ON | 不要 | `DISABLE=1`（`ENABLE=1` は deprecated 互換） |
| v0.18.0+ | ON | 不要 | `DISABLE=1`（`ENABLE=1` 完全撤去） |

---

## 3. v0.17 における env 優先順位（明文化）

```
優先順位: DISABLE=1 > ENABLE=1 > default
```

| DISABLE | ENABLE | v2 状態 | 備考 |
|---|---|---|---|
| 未設定 / 非"1" | 未設定 / 非"1" | **ON** | default-on |
| 未設定 / 非"1" | "1" | ON | ENABLE は deprecated だが互換受理 |
| "1" | 未設定 / 非"1" | **OFF** | kill switch |
| "1" | "1" | **OFF** | **DISABLE wins** |

- `"1"` 以外の値（`"true"`, `"yes"`, `"0"`, `" "` 等）は未設定扱い
- 両方セット時は DISABLE が必ず勝つ（二重否定を防ぐ）
- この exact-match セマンティクスは v0.16 で lock 済み（commit `2a40922`）

---

## 4. v0.17 での実装差分概要（Batch B で実施）

`src/server-windows.ts` の v2 フラグチェックを以下の通り書き換える。

**Before (v0.16 / opt-in):**
```ts
process.env.DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2 === "1"
```

**After (v0.17 / default-on):**
```ts
process.env.DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2 !== "1"
```

ログ出力も合わせて更新する:
- `DISABLE=1` 時: `[desktop-touch] v2 tools: disabled (DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1)`
- デフォルト ON 時: `[desktop-touch] v2 tools: enabled (default-on)`
- `ENABLE=1` が残っている場合: `[desktop-touch] DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2 is deprecated in v0.17; use DISABLE to opt out`

今バッチ (Batch A) はドキュメントのみ。コード変更は Batch B。

---

## 5. ENABLE=1 の Deprecation Path

| フェーズ | 動作 |
|---|---|
| v0.16.x | `ENABLE=1` が唯一の opt-in 手段。有効 |
| v0.17.x | `ENABLE=1` は deprecated。受理されるが startup log に deprecation warning を出す |
| v0.18.0+ | `ENABLE=1` は完全撤去。セットしても無視される |

移行手順（ユーザー向け）:
1. v0.17 に上げたら `ENABLE=1` を MCP 設定から削除
2. v2 を OFF にしたい場合は `DISABLE=1` を追加
3. v2 を ON のままでよければ何もしない

---

## 6. Option A を選んだ理由

**Option B（docs のみ）を却下した理由:** env 設計を先送りするだけで dogfood 不足や coexistence 未整理は何も解決しない。

**Option C（`V2_MODE=on|off|default`）を却下した理由:** three-state の意味を説明する docs コストが高く、rollback UX が劣化する。simple kill switch の方が信頼性が高い。

**Option A を採択した理由:**
1. kill switch が 1 行で説明できる（`DISABLE=1` を追加して再起動）
2. 実装差分が極小（`=== "1"` → `!== "1"` の反転）
3. 既存 dogfooder は v0.17 に上げても `ENABLE=1` が無害に残る（1 minor の互換期間）
4. 二重否定の `ENABLE=0` という紛らわしい表現を避けられる

---

## 7. Kill Switch の UX

**v0.17+ でのユーザー操作（v2 を OFF にしたい場合）:**

Claude Desktop:
```json
{
  "env": {
    "DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2": "1"
  }
}
```

再起動のみで完了。コード変更・再インストール不要。V1 tools は継続動作。

**戻す（v2 を再び ON にしたい場合）:**

上記の env エントリを削除して再起動。
