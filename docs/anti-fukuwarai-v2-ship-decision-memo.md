# Anti-Fukuwarai v2 — Ship / No-Ship Decision Memo

作成: 2026-04-22  
フェーズ: Phase 4 / Batch P4-D  
ブランチ: `desktop-touch-mcp-fukuwaraiv2`

---

## Decision

**Ship experimental in next release (v0.16.0)**

`desktop_see` / `desktop_touch` を `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` で opt-in できる experimental surface として、次の release note に掲載する。default OFF を維持する。

---

## Why

| Phase | 結論 |
|---|---|
| P4-A Experimental Quality Review | P0 なし。P1 × 2（modal/viewport/focus wiring 未接続、terminal focus steal）。Experimental として成立。 |
| P4-B Default-On Readiness | default-on 見送り。rollback は env flag 削除のみ。opt-in 継続を正式化。 |
| G1 + G2 Blockers | P1-1（modal/viewport/focus wiring）✅ 閉。P1-2（terminal background path）✅ 閉。必須 blocker ゼロ。 |
| P4-C Release Planning Review | Packaging ✅ 問題なし。README V2 セクション ✅ 追加済み。Versioning 推奨 `0.16.0` (minor)。 |
| P4-D HTTP Preflight | `scripts/test-http-mcp.ps1` 6/6 **ALL TESTS PASSED** (tool count: 58、version 0.15.7 確認)。 |

---

## Current Gate Status

| Gate | 状態 | 詳細 |
|---|---|---|
| G1 modal / viewport / focus wiring | ✅ 閉 | session-registry 側で production guard 配線済み |
| G2 terminal background path | ✅ 閉 | WM_CHAR 優先、unsupported は explicit throw |
| build pass | ✅ | tsc pass |
| unit tests (5 files / 364 tests) | ✅ | vitest run pass |
| stub-catalog check | ✅ | 58 tools、diff なし |
| HTTP preflight 6/6 | ✅ | 2026-04-22 実施、ALL TESTS PASSED |
| README V2 experimental セクション | ✅ | README.md + README.ja.md 追加済み |
| release-process.md との整合 | ✅ | Phase 1-7 に沿って実行可能な状態 |
| npm version / tag / publish | ⬜ 未実施 | release 実行 phase でユーザーが判断する |

**全 gate が ✅ または release 実行 phase で完了する項目のみ。ブロッカーなし。**

---

## Env Policy

| 変数 | 効果 |
|---|---|
| `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` | `desktop_see` / `desktop_touch` を MCP catalog に公開する |
| 未設定 (default) | V2 tools は公開されない。V1 tools のみ (zero side-effects) |

---

## Conditions to Ship

以下をすべて満たした状態で release 実行する。

1. ✅ `npm run build` pass
2. ✅ unit tests pass
3. ✅ HTTP preflight 6/6 pass
4. ✅ README に V2 experimental セクションがある
5. ⬜ `npm version 0.16.0 --no-git-tag-version` で package.json / src/version.ts / bin/launcher.js を更新する
6. ⬜ `git commit + git tag v0.16.0 + git push origin v0.16.0` で CI を起動する
7. ⬜ CI: GitHub Release zip + npm publish 完了を確認する
8. ⬜ npx smoke test + MCP registry publish (Phase 7)

5–8 は release-process.md の Phase 1–7 に従って実行する。

---

## Conditions to Hold

次のいずれかが発覚した場合は Hold に倒す。

- HTTP preflight が pass しない（再実施時に失敗）
- `npm version 0.16.0` 実行後に build / test が fail
- CI (windows-release / npm-publish) job が fail
- ship 後の npx smoke test で ZIP 破損 / version 不一致が検出された場合は `npm deprecate` で即座に回収する

---

## Rollback / Kill Switch

**ユーザー操作**: MCP 設定から `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` を削除してサーバーを再起動する。

```json
// 削除前
{ "env": { "DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2": "1" } }

// 削除後（V1 のみ）
{ "env": {} }
```

- コード変更不要
- 再インストール不要
- V1 tools は常時有効（フラグによる影響なし）

**npm 側 rollback**: 問題のある version が published されてしまった場合は `npm deprecate` を使う（`npm unpublish` より安全）。

---

## Next Action

release-process.md Phase 1-7 に従って実行する。具体的な順序:

```
1. npm version 0.16.0 --no-git-tag-version
   (自動更新: package.json, package-lock.json, src/version.ts, bin/launcher.js)
2. node --check bin/launcher.js && npm run build
3. git commit && git tag v0.16.0 && git push origin HEAD:main && git push origin v0.16.0
4. CI: windows-release job (zip 生成) + npm-publish job (SHA256 更新 + npm publish) を待つ
5. npx smoke test (clean cache) で動作確認
6. server.json を v0.16.0 に更新して mcp-publisher publish
```

**注意**: `bin/launcher.js` の `sha256` は CI が自動更新する。Phase 6 完了後まで `"PENDING"` のままで正常。

---

## 参照ドキュメント

- [anti-fukuwarai-v2-release-planning-review.md](anti-fukuwarai-v2-release-planning-review.md) — P4-C 詳細
- [anti-fukuwarai-v2-default-on-readiness.md](anti-fukuwarai-v2-default-on-readiness.md) — rollback policy 詳細
- [release-process.md](release-process.md) — 実行手順（リリース時は必ず full read）
