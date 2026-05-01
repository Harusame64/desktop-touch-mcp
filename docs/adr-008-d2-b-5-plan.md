# ADR-008 D2-B-5 — operator-induced view-hit MCP round-trip bench

- Status: **Drafted v0.1 (Sonnet 起草、Opus + Codex レビュー前)**
- Date: 2026-05-02
- Authors: Claude (Sonnet) — `desktop-touch-mcp`
- 親 ADR: `docs/adr-008-reactive-perception-engine.md` §4 D2 / §8 D2
- 親 plan: `docs/adr-008-d2-plan.md` §10 OQ #2 / OQ #16
- prerequisite: PR #98 D2-B-3/4 (steady-state baseline 取得済、`benches/d2_desktop_state_roundtrip.mjs`)
- 後続 PR: views-catalog §3.1 SLO 4 種分解 + 8 SSOT 同期 + OQ #2/#16 Resolved 化 (本数値が precise 文言確定の prerequisite)

---

## 0. なぜ本 PR が必要か (Opus 諮問判断 2026-05-02 R1)

ADR-008 D2 OQ #2 / OQ #16 を解消する SLO 文言正確化 PR (案 (2) 採択、Opus 独立判断 2026-05-02) において、views-catalog §3.1 の `MCP round-trip p99 SLO` の precise 数値確定の prerequisite として、**operator-induced focus change 後の view path hit 経路の MCP round-trip p99 数値** が必要。

D2-B-4 (PR #98) の steady-state 計測 (focus 変化なし、`focusedElementSource: uia 100%`、p99 6.22ms) では view 経路がヒットしないため、view-replacement の真の効果を観測できない。focus 変化を 1 回起こせば `latest_focus` view が populate され、後続の `desktop_state` 呼出で view path hit (`focusedElementSource: view`) が成立する。本 bench でその数値を取得する。

**判断分岐**: 取得後の数値で views-catalog §3.1 SLO の MCP round-trip p99 文言が確定する:

- view-hit p99 が **1-2ms 以下** → SLO `< TS p99 / 5 (~2ms)` で確定 (view-replacement の効果 high)
- view-hit p99 が **2-5ms** → SLO `< TS p99 / 1.5 (~6ms)` で確定 (現在の steady-state と同水準)
- view-hit p99 が **5ms 以上** → SLO `< 10ms` で確定 (view-replacement の効果 marginal、OQ #2 永久 defer の根拠強化)

---

## 1. Scope

### 1.1 本 PR で完結

A. **`benches/d2_desktop_state_roundtrip.mjs` の `--induce-focus-change` mode 追加** — warmup 期間内で focus 変化を programmatic に 1-2 回誘導、measure phase で view-hit iter を観測
B. **metric の 3 分解出力** — overall p99 (D2-B-4 互換、regression 0 確認) + view-hit iter のみ p99 + non-view (uia/cdp fallback) iter のみ p99
C. **`benches/README.md` §2.3 への D2-B-5 行追加** — 計測手順 + 実測値 + acceptance interpretation
D. **本 sub-plan doc の land** (`docs/adr-008-d2-b-5-plan.md` 自身)

### 1.2 本 PR では実装しない (carry-over)

- views-catalog §3.1 SLO 4 種分解 + 8 SSOT 同期更新 → **PR-2 (本 PR merge 後の後続 PR)** で実施
- OQ #2 / OQ #16 の Resolved 化 → 同 PR-2 で実施
- option C-2/C-3 release semantics 再設計 → **永久 defer** (Opus 諮問判断 2026-05-02、`feedback_auto_progress_d2_option_c.md` 参照)

---

## 2. 設計

### 2.1 focus change induction 手段

選定: **`@nut-tree-fork/nut-js` 経由で alt+tab を programmatic 送信** (project dependency に既存、`package.json:77`)。

理由:
- nutjs は既に project の MCP tool (`mouse_click` / `keyboard` 等) で利用中、新規 dependency 不要
- nutjs の `keyboard.pressKey(Key.LeftAlt, Key.Tab)` + `keyboard.releaseKey(...)` で alt+tab 1 回送信
- 別 process spawn 不要 (PowerShell SendKeys 案より overhead 小)
- bench process と native addon (UIA bridge / focus_pump) は同 OS user session 配下で動作、focus event の routing が確実

代替案 (採用せず、§6 OQ #1 で再検討余地):

- (b) PowerShell `[System.Windows.Forms.SendKeys]::SendWait("%{TAB}")` 経由 — child_process spawn overhead、focus shift 中の race
- (c) Win32 `keybd_event` を native addon に新規 export — production 経路を改変するリスク、本 bench scope 外
- (d) operator-induced (現状 OPERATOR NOTE 維持) — 自動化失敗時 fallback として `--manual` flag で残す

### 2.2 induction タイミング

warmup phase 100 iters のうち:
- iter 30 で 1 回目の alt+tab (focus が他 window に移行、`UiaFocusChanged` event A 発火)
- iter 30 + 200ms wait
- iter 50 で 2 回目の alt+tab (focus が元の terminal に戻る、event B 発火)
- iter 50 + 200ms wait
- 残り warmup iters で focus_pump が view に reflect 完了

200ms wait は L1 ring → focus_pump → latest_focus view の transit + frontier release 待ちのため (`shift_ms = 100ms` floor + idle-advance 1 cycle)。

measure phase 1000 iters では `focusedElementSource: view` が観測される想定 (focus が安定している限り、`view_get_focused()` が hit、`desktop-state.ts:shouldAcceptViewFocus` 3 ゲートラダー pass)。

### 2.3 metric 3 分解

bench 出力:

```
# d2_desktop_state_roundtrip — MCP stdio transport (1000 iters, --induce-focus-change)
overall:
  mean : XX.XX µs
  p50  : XX.XX µs
  p95  : XX.XX µs
  p99  : XX.XX µs (← D2-B-4 互換、regression 0 確認)
  max  : XX.XX µs

view-hit (focusedElementSource = "view", N=NNN iters):
  mean : XX.XX µs
  p50  : XX.XX µs
  p95  : XX.XX µs
  p99  : XX.XX µs (← OQ #2/#16 SLO 確定の根拠数値)
  max  : XX.XX µs

non-view (uia/cdp fallback, N=NNN iters):
  mean : XX.XX µs
  p99  : XX.XX µs

# focusedElementSource distribution:
#   view : NNN (NN.N%)
#   uia  : NNN (NN.N%)
#   cdp  : NNN (NN.N%)
```

view-hit iter が 0 件の場合は acceptance fail (operator note + exit code 1)。

### 2.4 CLI flag

新規:

| flag | default | 効果 |
|---|---|---|
| `--induce-focus-change` | **default ON** (新 mode) | warmup phase 内で alt+tab 2 回送信 |
| `--manual` | OFF | 自動 induction を skip、operator-induced (D2-B-4 既存挙動) |
| `--no-induce` | OFF | エイリアス of `--manual` |

既存:
- `[iterations >= 100]` (位置引数、互換維持)

D2-B-4 互換性: 既存呼出 `node benches/d2_desktop_state_roundtrip.mjs 1000` は `--induce-focus-change` 暗黙 ON で view-hit measure するが、`--manual` を渡せば D2-B-4 完全互換 (D2-B-4 数値の再現確認用、§6 OQ #2 で再検討)。

---

## 3. 実装範囲 (1 PR、~200-300 line)

### 3.1 file 変更一覧

| file | 変更内容 | line 増分 |
|---|---|---|
| `benches/d2_desktop_state_roundtrip.mjs` | `--induce-focus-change` mode 追加 / nutjs import / induction logic / metric 3 分解計算 / 出力 format 拡張 | +120-180 |
| `benches/README.md` | §2.3 に D2-B-5 sub-section 追加 (計測手順 + 実測値 table + acceptance interpretation) | +30-50 |
| `docs/adr-008-d2-b-5-plan.md` | 本 sub-plan 自身 | +200-300 |
| `docs/adr-008-d2-plan.md` | §10 OQ #16 行に「D2-B-5 で view-hit 数値取得」を追記 (Resolved 化は PR-2、本 PR は status update のみ) | +5 |

### 3.2 acceptance gate

- view-hit counter > 0 (`focusedElementSource: view` iter が 1 件以上観測) — fail 時 exit code 1
- view-hit p99 数値が出力される (Float64 として valid、NaN/Infinity でない)
- overall p99 が D2-B-4 から regression 5% 以内 (= 6.22ms × 1.05 ≈ 6.53ms 以下)
- bench script 起動成功 + 終了 (exit code 0 / 1 のいずれか、SIGABRT 等の crash 不可)

### 3.3 fallback (auto induction 失敗時)

nutjs alt+tab 送信が以下の env で失敗する可能性:
- RDP セッション (focus stealing prevention で alt+tab が抑止)
- multi-monitor + 特殊 IME 設定
- group policy で alt+tab disabled
- bench 実行 user に input 権限なし (UAC 上昇 process が前面、低優先 process は input block)

対応:
1. nutjs `keyboard.pressKey` が throw → catch + warning + `--manual` 相当の挙動に degrade
2. measure phase 終了時 view-hit counter == 0 → operator note 表示 + exit code 1 (acceptance fail)
3. `--manual` flag 明示時は auto induction を完全 skip、view-hit counter == 0 でも exit code 0 (operator 判断)

### 3.4 review 軸

CLAUDE.md §3.3 Step 0 の PR 種別判断:
- 本 PR は **bench harness 改修** (production code 不変、`benches/*` のみ touch)
- production への副作用なし、ただし bench は ADR contract に直結 (SLO 確定の根拠数値)
- → **Opus + Codex 各 1 round** (Opus = north star + 諮問判断との整合、Codex = bench script の API contract / metric 計算式 / nutjs 互換性)

自動進行モード (`feedback_auto_progress_d2_option_c.md`):
- Opus P1 + P2 ゼロ + Codex P1 ゼロ で Opus 単独 merge 判断

---

## 4. acceptance criteria

### 4.1 機能

- [ ] `node benches/d2_desktop_state_roundtrip.mjs 1000 --induce-focus-change` で view-hit counter > 0 (3 回連続実行で安定確認)
- [ ] view-hit iter のみの p99 が出力される (数値 valid)
- [ ] non-view iter のみの p99 が出力される (数値 valid)
- [ ] overall p99 が D2-B-4 互換 (regression 5% 以内)
- [ ] `--manual` flag で D2-B-4 完全互換挙動 (auto induction skip)
- [ ] auto induction 失敗時の error path (nutjs throw → warning + degrade)

### 4.2 docs

- [ ] `benches/README.md` §2.3 に D2-B-5 sub-section 追加 (3 分解 metric + 計測手順 + 実測値 + acceptance interpretation)
- [ ] `docs/adr-008-d2-plan.md` §10 OQ #16 行に「D2-B-5 で view-hit 数値取得」status update

### 4.3 review

- [ ] Opus phase-boundary review で P1 + P2 全件ゼロ化 (自動進行モード基準)
- [ ] Codex review で P1 全件ゼロ化
- [ ] Opus 単独 merge 判断で merge (Codex クレジット切れ時も Opus 単独)

---

## 5. risks

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | nutjs alt+tab が environment 依存で動かない (RDP / multi-monitor / group policy / focus stealing prevention) | 中 | catch + warning + `--manual` 相当 fallback、view-hit counter 0 時 acceptance fail で operator に明示 |
| R2 | alt+tab で別 window に focus 移行 → bench MCP server process の stdio が detach? | 低 | bench process と server process は parent-child で stdio pipe 結合、focus 移行は input routing のみで stdio に影響なし。実機確認は impl 時 |
| R3 | focus 変化 induction 後、`latest_focus` view の populate が遅延 (frontier release が `shift_ms` floor 律速) | 低 | warmup 200ms wait × 2 回で `shift_ms = 100ms` を 2 cycle 含む十分な余裕 |
| R4 | `focusedElementSource: view` が observed されても、実態は `current_focused_element` view 経由の別 hit (sentinel 拡張前の cdp/uia と判別できない可能性) | 低 | `desktop-state.ts:shouldAcceptViewFocus` の 3 ゲートラダー (empty-name / Chromium-Pane / foreground-match) で view sentinel が立つのは確実、PR #97 D2-B-2 で contract test pin 済 |
| R5 | view-hit p99 と non-view p99 が逆転 (view path がむしろ遅い) | 中 | 実測値で評価、逆転していれば views-catalog §3.1 SLO 文言で「view-replacement の効果 marginal」を historical note に明記して PR-2 で finalize。本 PR 自体は数値取得のみで判断は PR-2 で |
| R6 | bench script の改修で D2-B-4 invocation (`--manual` 経路) に regression が入る | 高 | `--manual` flag 経路を D2-B-4 と完全 bit-equal 維持、unit test (vitest) で `--manual` 出力が D2-B-4 既存出力 schema と互換であることを pin。ただし vitest で外部 process spawn は重いので、bench script の pure parser 関数を切り出して unit test、main flow は smoke test 1 件のみ |
| R7 | bench measure phase 中に operator が手動で focus 変化を起こす (= ノイズ) | 低 | bench 実行中は terminal 操作禁止を operator note で明示、CI / 一発計測前提 |
| R8 | nutjs import が ESM でコケる (project は `type: module`) | 低 | nutjs は dual ESM/CJS export、import で動作確認済 (production の MCP tool で利用中)。bench は既に ESM `.mjs` |

---

## 6. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | nutjs 経由 alt+tab vs Win32 `keybd_event` 直叩き (native addon に bench-only export 新設) | impl 時、nutjs で動作不安定なら addon export を別 PR carry-over (本 PR scope 外) |
| 2 | `--induce-focus-change` を default ON にするか OFF にするか — default ON だと既存 D2-B-4 invocation の挙動が変わる | impl 時、user feedback (本 sub-plan review) で確定 |
| 3 | bench を CI で動かすか manual のみか — alt+tab は GUI session 必須、GitHub Actions windows-latest は GUI 制約あり | 本 PR では manual 専用、CI 化は future enhancement |
| 4 | view-hit p99 の sample 数下限 (例: view-hit 件数が 50 件未満なら p99 信頼性低) | impl 時、acceptance gate に「view-hit count >= 50 (1000 iter の 5%)」を追加するか判断 |

---

## 7. PR 切り方

1 PR 完結 (本 PR-1):
- branch: `feature/adr-008-d2-b-5-plan` (本 sub-plan land + impl 同 PR、~200-300 line)
- impl 部分が小規模なので分割不要
- CLAUDE.md §3.3 Step 1 (Opus phase-boundary review) + Step 2 (Codex re-review) を本 PR で適用

merge 後の後続 PR (本 sub-plan scope 外):
- **PR-2**: views-catalog §3.1 SLO 4 種分解 + 8 SSOT 同期 + OQ #2/#16 Resolved 化 (Opus 諮問判断 §5)
- D2-D 着手 (semantic_event_stream FocusMoved 単独成立、本 OQ closure 後の D2 walking skeleton expansion phase 復帰)

---

## 8. 関連

- 親 ADR: `docs/adr-008-reactive-perception-engine.md` §4 D2 / §8 D2
- 親 plan: `docs/adr-008-d2-plan.md` §10 OQ #2 / OQ #16
- D2-B-4: PR #98 (`f79e9ec`)、`benches/d2_desktop_state_roundtrip.mjs` 既存実装
- Opus 諮問判断: 本 sub-plan §0 (2026-05-02 採択、案 (2) SLO 置き直し採択、§3 留保事項 R1 = 本 PR で取得)
- 自動進行モード基準: `feedback_auto_progress_d2_option_c.md` (Opus P1+P2 ゼロ + Codex P1 ゼロ + Opus 単独 merge)
- nutjs dep: `package.json:77` `@nut-tree-fork/nut-js` ^4.2.6
- views-catalog SLO: `docs/views-catalog.md` §3.1 (現行 `update p99 < 1ms` 表記、本 PR 後の PR-2 で 4 種分解)

---

## Appendix A: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Drafted v0.1 | 2026-05-02 | Claude (Sonnet) | 初稿起草、Opus 諮問判断 (2026-05-02) §3 留保事項 R1 解消のための bench 拡張 plan、nutjs alt+tab 自動 induction + metric 3 分解 + acceptance gate (view-hit counter > 0) + fallback (operator-induced manual) |

---

END OF ADR-008 D2-B-5 sub-plan v0.1 (Drafted)。
