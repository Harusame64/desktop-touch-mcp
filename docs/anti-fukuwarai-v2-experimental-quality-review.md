# Anti-Fukuwarai v2 Experimental Quality Review

作成: 2026-04-22  
対象: Phase 4 / Batch P4-A  
ブランチ: `desktop-touch-mcp-fukuwaraiv2`

---

## 1. 結論

P4-A のレビュー材料は揃った。  
現時点の `desktop_see` / `desktop_touch` は **experimental としては成立**しているが、**default-on 候補としてはまだ早い**。

判断理由は次の通り。

- `desktop_see` / `desktop_touch` の基本 contract は unit test と build で確認できた
- browser / terminal / visual lane の基本 routing は成立している
- stale lease safe fail は成立している
- 一方で、**modal / viewport / focus steal の production wiring が未接続**で、Phase 4 の safe fail 観点を満たし切っていない
- terminal executor は依然として foreground path で、focus steal を引き起こす

P0 は見つかっていないが、P1 を残したまま default-on 判断へ進めるのは危険である。

---

## 2. 今回の review で直した点

P4-A のレビュー開始時点で、public contract とズレる挙動が 2 件あったため、先に修正した。

- `desktop_see` の `target` 省略時に、`no_provider_matched` ではなく **foreground window を解決して routing** するようにした
- `target: { hwnd }` だけの terminal window が title 不足で terminal lane に乗らない経路を補正し、**live title を解決して terminal routing** できるようにした

合わせて、branch 上に残っていた type drift を整理し、`npm run build` が通る状態へ戻した。

---

## 3. 検証ログ

### 実行コマンド

```bash
npx vitest run tests/unit/desktop-providers-active-target.test.ts tests/unit/desktop-providers.test.ts tests/unit/guarded-touch.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-executor.test.ts tests/unit/desktop-register.test.ts tests/unit/benchmark-gates.test.ts
npm run build
```

### 結果

- vitest: `7 files / 119 tests passed`
- build: `tsc passed`

主な根拠ファイル:

- [`tests/unit/desktop-facade.test.ts`](../tests/unit/desktop-facade.test.ts)
- [`tests/unit/guarded-touch.test.ts`](../tests/unit/guarded-touch.test.ts)
- [`tests/unit/desktop-executor.test.ts`](../tests/unit/desktop-executor.test.ts)
- [`tests/unit/benchmark-gates.test.ts`](../tests/unit/benchmark-gates.test.ts)
- [`tests/unit/desktop-providers-active-target.test.ts`](../tests/unit/desktop-providers-active-target.test.ts)

---

## 4. Scenario Checklist

| Scenario | Status | 根拠 | コメント |
| --- | --- | --- | --- |
| browser form 入力 | Pass | [`desktop-executor.test.ts`](../tests/unit/desktop-executor.test.ts) の `cdpFill` route、[`desktop-facade.test.ts`](../tests/unit/desktop-facade.test.ts) の `action + text` pass-through | 基本動作は成立。ただし CDP port は現状 `9222` 固定 |
| browser button click | Pass | [`desktop-executor.test.ts`](../tests/unit/desktop-executor.test.ts) の `cdpClick` route | selector ベースで click できる |
| terminal command send | Pass with caveat | [`desktop-executor.test.ts`](../tests/unit/desktop-executor.test.ts) の terminal route | 実行経路はあるが foreground typing で focus を奪う |
| terminal prompt 追従 | Pass with caveat | [`guarded-touch.test.ts`](../tests/unit/guarded-touch.test.ts) の terminal textbox `value_changed` | prompt の意味 diff は取れるが、focus safety は未接続 |
| native dialog 操作 | Partial | [`desktop-executor.test.ts`](../tests/unit/desktop-executor.test.ts) の UIA route / fallback、[`guarded-touch.test.ts`](../tests/unit/guarded-touch.test.ts) の `modal_blocking` | GuardedTouchLoop 側の概念はあるが、production facade では modal check が未配線 |
| visual-only target 認識 | Pass | [`benchmark-gates.test.ts`](../tests/unit/benchmark-gates.test.ts) Gate 1 | visual candidate が `desktop_see` に載る |
| stale lease / modal / focus steal の safe fail | Partial | [`guarded-touch.test.ts`](../tests/unit/guarded-touch.test.ts) の lease rejection / modal / focus diff | stale lease は Pass。modal / focus steal は generic loop では可能だが production wiring が不足 |

---

## 5. Issue List

### P0

- なし

### P1

#### P1-1. `desktop_touch` production wiring に modal / viewport / focus 観測が入っていない

根拠:

- [`src/engine/world-graph/session-registry.ts`](../src/engine/world-graph/session-registry.ts) の `TouchEnvironment`
- `isModalBlocking` は未指定時 `() => false`
- `isInViewport` は未指定時 `() => true`
- `getFocusedEntityId` は production wiring で未設定

影響:

- Phase 4 の safe fail 観点のうち、**stale lease は成立**しているが、**modal / focus steal は facade surface では保証されない**
- `native dialog 操作` と `safe fail` の評価を Partial にとどめる主因

推奨:

- P4-B 前に `desktop_touch` へ minimum production guard を配線する
- 少なくとも modal / viewport / focus の 3 つは facade 側で観測可能にする

#### P1-2. terminal executor が foreground path で focus を奪う

根拠:

- [`src/tools/desktop-executor.ts`](../src/tools/desktop-executor.ts)
- `terminalSend()` が `restoreAndFocusWindow()` + `keyboard.type()` を使用

影響:

- terminal command send 自体は通るが、LLM UX と failure clarity を悪化させる
- browser / native app と並行した操作で blast radius が読みにくい

推奨:

- 既存 `terminal_send` の background / WM_CHAR 系 path を reuse する
- P4-B 以降の default-on readiness では foreground dependency を減らす

### P2

#### P2-1. visual runtime attach race により first request warning が出うる

根拠:

- [`src/tools/desktop-register.ts`](../src/tools/desktop-register.ts) の `initVisualRuntime()` コメント
- `getDesktopFacade()` は async attach を await せず return する

影響:

- 初回 `desktop_see` で `visual_provider_unavailable` が混ざる可能性がある
- steady state では問題が薄いが、default-on 時は warning noise になりうる

推奨:

- facade init の async 化、または first-call retry / warm attach policy を追加する

#### P2-2. browser path が default CDP port (`9222`) 前提

根拠:

- [`src/tools/desktop-executor.ts`](../src/tools/desktop-executor.ts) の `cdpClick` / `cdpFill`
- `TargetSpec` に `cdpPort` がない

影響:

- 非デフォルト port の browser session で V2 facade がそのまま使えない
- browser scenario は通るが、運用の前提がまだ狭い

推奨:

- `TargetSpec` へ optional `cdpPort` を追加するか、既存 browser tooling の target 解決を reuse する

### Polish

- review note 上は `browser form` / `native dialog` / `visual-only` の質的比較材料が unit test 中心で、dogfood 実録はまだ薄い
- P4-B に入る前に short dogfood log を 3-5 scenario ぶん足すと判断しやすい

---

## 6. P4-A Outcome

P4-A の完了判定は **Pass** とする。  
理由は、scenario ごとの pass / partial が整理され、P0/P1/P2 を分けた issue list ができたためである。

ただし、この Pass は **「default-on readiness がある」ことを意味しない**。  
現時点の判断は次の通り。

- `Ship experimental (default OFF)` は候補
- `default-on` はまだ不可
- 次の着手点は P4-B の readiness / kill switch 整理で、その前提として P1 をどう扱うか決める
