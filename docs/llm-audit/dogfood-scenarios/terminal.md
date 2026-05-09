# Dogfood Scenarios — terminal (action: send / run)

- Status: **manual / dogfood scenarios for Phase 2b execution audit**
- Date: 2026-05-09
- Origin: `docs/llm-audit/phase2b-execution-audit.md` §3.1 carry-over (Plan §6 acceptance 2 経路目)
- Scope: terminal:send BG / terminal:send FG / terminal:run の実機 GUI 依存シナリオ
- Parent audit section: 本 doc §1.x は `phase2b-execution-audit.md` §3.1 (terminal、cell 1-3) の carry-over scenario。各シナリオは parent table の cell 内 `dogfood-scenarios/terminal.md §1.x` 参照と相互リンク

CI で安定的に再現できない実機 GUI 依存シナリオを永続化。Claude session 都度の手動 trial で audit reference として使う。production-side regression を疑った時に最初に当たる SSOT。

**Cross-link**: clipboard 経路の cause / anti-pattern (clipboard manager intercept、DLP、RDP transcoding) は `clipboard.md` §5.2-5.3 を併読。terminal:send FG `preferClipboard:true` (本 doc §1.2) は clipboard.md と chain 関係にある。

---

## 1. terminal シナリオ

### 1.1 terminal:send BG — hidden_input_prompt verifyDelivery hint (existing E2E 補強)

**目的**: real PowerShell `Read-Host -AsSecureString` 入力で `hints.verifyDelivery: {status:"unverifiable", reason:"hidden_input_prompt"}` が返ることを確認 (matrix §3.1 line 137 規範)。`tests/unit/terminal-hidden-input.test.ts` は detector 単体、本 scenario は **end-to-end PowerShell 起動 → Read-Host prompt → terminal:send BG → envelope 観測** chain。

**手順**:
1. PowerShell 起動: `Start-Process pwsh -ArgumentList '-NoExit'`
2. terminal にて `$pw = Read-Host -Prompt 'Password' -AsSecureString` 投入 (前 send で credential prompt 状態に)
3. `terminal({action:'send', method:'background', windowTitle:'PowerShell', input:'mypassword'})` 呼出
4. response envelope 内 `hints.verifyDelivery.status === "unverifiable"` / `.reason === "hidden_input_prompt"` / `.fallback === "method:'foreground'"` を確認

**期待**: `ok:true` (BG path で送信成功) + `hints.verifyDelivery: unverifiable` (read-back skip)。
**Anti-pattern**: silent `ok:true` で `verifyDelivery` 不在 → silent-success regression (#173 と同型)。

### 1.2 terminal:send FG — preferClipboard / clipboard paste fallback (E1 dogfood SoT)

**目的**: `preferClipboard:true` で keystroke fallback が走り、`ClipboardWriteNotDelivered` が `terminal:send` warnings に nested で surface する shape を確認。E1 (automated pin gap) の代替 SoT。

**手順**:
1. clipboard manager (例: ClipDiary、Ditto、ClipboardFusion) を起動 / DLP / RDP transcoding を有効化
2. PowerShell 起動 + フォーカス
3. `terminal({action:'send', method:'foreground', windowTitle:'PowerShell', input:'echo unicode テスト 🎉', preferClipboard:true})` 呼出
4. response 観測: `ok:true` + `warnings:[{code:"ClipboardWriteNotDelivered", ...nested suggest}]` または `ok:false` + `code:"ClipboardWriteNotDelivered"` (clipboard path 完全失敗時)

**期待**: clipboard path 失敗時 → keystroke fallback → 入力成功 + warnings に nested code 付与。
**Anti-pattern**: silent `ok:true` で warnings 空 → clipboard regression がレビュー段階で見えない。

### 1.3 terminal:send FG — Win11 foreground refusal admin escalation

**目的**: target が elevated terminal (admin PowerShell) の場合、UIPI cross-elevation で `ForegroundRestricted` typed code が ok:false で返ることを実機確認。`issue-207-foreground-refusal-terminal.test.ts` は mock pin、本 scenario は real Win11 admin プロセスとの `cross-elevation` 確認。

**手順**:
1. admin PowerShell 起動 (`Start-Process pwsh -Verb RunAs`)
2. 通常ユーザー Claude セッションから `terminal({action:'send', method:'foreground', windowTitle:'Administrator: PowerShell', input:'echo hi', forceFocus:false})` 呼出
3. response 観測: `ok:false`、`code:"ForegroundRestricted"`、`context.attemptedForce === false`、`context.autoEscalated === true`、`context.hint` に `5 SetForegroundWindow retries` + `AttachThreadInput` 言及

**期待**: foreground 取得共拒否 → ok:false 早期 return、keystroke 抑止。
**Anti-pattern**: ok:true で elevated 窓に keystroke landing → セキュリティ regression (#202 同型)。

### 1.4 terminal:send BG → terminal:read (sinceMarker) chain

**目的**: BG send 後の incremental read chain が UIA TextPattern padding churn (trailing space / CRLF / blank line) で stable なことを確認。`tests/unit/terminal-marker.test.ts` の `applySinceMarker` を real Windows Terminal / conhost で end-to-end 検証。

**手順**:
1. Windows Terminal 起動 (PowerShell tab)、`for ($i=1; $i -lt 100; $i++) { echo "line $i"; Start-Sleep -Milliseconds 50 }` 投入で長 scrollback 生成
2. `terminal({action:'read', windowTitle:'Windows Terminal'})` で baseline 取得 → response の `marker` 保持
3. `terminal({action:'send', method:'background', windowTitle:'Windows Terminal', input:'echo new1'})` で新規 line 追加
4. `terminal({action:'read', windowTitle:'Windows Terminal', sinceMarker: <step2 marker>})` で incremental 読取

**期待**: response の `text` に `new1` のみ含み、`previousMatched:true`、padding churn を吸収して安定。
**Anti-pattern**: padding 1 char 差で marker miss → matched:false で full buffer 全文返却 (UIA padding regression)。

### 1.5 terminal:run — quiet / pattern_matched / timeout / window_closed 4 reason 確認

**目的**: matrix §3.1 line 139 「completion.reason 区別」の 4 主要 reason がそれぞれ実機で正しく返ることを確認。`tests/unit/terminal-run-validation.test.ts` は InvalidArgs 入力 + window_not_found のみ、本 scenario は real terminal で `quiet` / `pattern_matched` / `timeout` / `window_closed` の各 path を実走。

**手順**:
- **quiet**: `terminal({action:'run', windowTitle:'PowerShell', input:'echo quick', until:{mode:'quiet', quietMs:800}, timeoutMs:5000})` → completion.reason='quiet'
- **pattern_matched**: `input:'echo READY', until:{mode:'pattern', pattern:'READY'}` → completion.reason='pattern_matched'、`elapsedMs` 200ms 程度
- **timeout**: `input:'Start-Sleep 30', until:{mode:'pattern', pattern:'NEVER'}, timeoutMs:2000` → completion.reason='timeout'
- **window_closed**: 起動した PowerShell を mid-run で `Stop-Process` で kill → completion.reason='window_closed'

**期待**: 各 reason がそれぞれ正しく返り、`output` field の中身は reason 別に意味のある partial result (timeout なら累積 stdout、window_closed なら kill 直前まで)。
**Anti-pattern**: timeout → quiet 偽装、window_closed → silent ok:true (#173 同型)。

### 1.6 terminal:run — until.pattern empty regex `/^$/` (round-7/8 regression baseline)

**目的**: `tests/unit/terminal-run-validation.test.ts:184-197` の「empty regex 真偽」が実機 round-trip でも維持されること。

**手順**:
1. `terminal({action:'run', windowTitle:'PowerShell', input:'echo ""', until:{mode:'pattern', pattern:'^$'}, timeoutMs:3000})`
2. 出力に空行が混入した瞬間に completion.reason='pattern_matched' 即時返却を確認

**期待**: empty pattern が空行で match、即時 return。
**Anti-pattern**: truthiness gate で empty content が skip → timeout (#37 round-7/8 regression)。

### 1.7 terminal:run send 失敗時 nested code surface chain

**目的**: matrix §3.1 line 139「`send_failed` は send 側 code を warnings に surface」contract の実機確認。`tests/unit/terminal-run-validation.test.ts` Note 212-219 で「refactoring out of scope」と記された read-failure propagation を E2E で代替 audit。

**手順**:
1. window 不在の windowTitle で `terminal({action:'run', windowTitle:'__nonexistent__', input:'echo hi'})` 呼出
2. response 観測: `ok:false`、`completion.reason === 'window_not_found'`
3. `terminal({action:'run', windowTitle:'PowerShell', input:'echo hi', method:'foreground', preferClipboard:true})` で elevated terminal を target にして clipboard write 失敗を誘発
4. response 観測: `completion.reason === 'send_failed'`、`warnings[]` に send 側 code (例: ClipboardWriteNotDelivered) が nested surface

**期待**: send 失敗が ok:false + completion.reason='send_failed' + warnings nested code、partial output は `output` field に維持。
**Anti-pattern**: send 失敗 → silent ok:true、warnings 空、completion.reason='quiet' 偽装。

---

## 2. 共通操作上の note

- **Windows Terminal (WT) 注意**: WT の WinUI/XAML pipeline は WM_CHAR を silently swallow (#173)、auto-routing は foreground fallthrough。BG path 検証時は **conhost / cmd / pwsh (ConsoleWindowClass)** を target にする。`Start-Process conhost.exe -ArgumentList 'pwsh.exe'` で旧 conhost host で起動可能。
- **admin terminal target 注意**: `Verb=RunAs` で起動した PowerShell は UIPI cross-elevation で foreground refused、本 audit の expected behavior。通常ユーザー Claude session で keystroke を送るな (security guardrail、#202 北極星)。
- **clipboard manager intercept 検証**: ClipDiary / Ditto / ClipboardFusion / DLP solution / RDP transcoding が active な環境で `preferClipboard:true` を試して `ClipboardWriteNotDelivered` 検出 path を確認 (matrix §5.2 false-positive policy 整合)。
