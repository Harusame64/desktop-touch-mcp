# Dogfood Scenarios — clipboard (clipboard:write)

- Status: **manual / dogfood scenarios for Phase 2b execution audit**
- Date: 2026-05-09
- Origin: `docs/llm-audit/phase2b-execution-audit.md` §3.5 carry-over
- Scope: clipboard:write の実機 GUI 依存シナリオ
- Parent audit section: 本 doc §5.x は `phase2b-execution-audit.md` §3.5 (clipboard、cell 15) の carry-over scenario。各シナリオは parent table の cell 内 `dogfood-scenarios/clipboard.md §5.x` 参照と相互リンク

**Cross-link**: clipboard:write 経路の cause / anti-pattern は terminal:send FG `preferClipboard:true` (`terminal.md` §1.2) と chain 関係。Both docs は同 root cause (clipboard manager intercept、DLP、RDP transcoding) を扱う。

---

## 5. clipboard シナリオ

### 5.1 clipboard:write — Set-Clipboard / Get-Clipboard byte-equal round-trip (existing E2E 補強)

**目的**: matrix §3.1 line 151 規範「`Set-Clipboard` 後 `Get-Clipboard -Raw` で byte 単位 (UTF-16LE) 一致確認」を real Windows で end-to-end 検証。`tests/e2e/clipboard-readback.test.ts` の補強 audit。

**手順**:
1. `clipboard({action:'write', text:'Hello World 日本語 🎉'})` 呼出
2. response 観測: `ok:true`、`hints.verifyDelivery.status === 'delivered'` (read-back 一致)
3. PowerShell 別 session で `Get-Clipboard -Raw` 実行 → exact byte sequence 確認
4. Notepad / Edge URL bar で Ctrl+V → 完全に同じ文字列 (絵文字含む) が landing

**期待**: UTF-16LE で byte-equal、surrogate pair も完全保持、形式変換なし。
**Anti-pattern**: silent ok:true で read-back 失敗 → 別 app で paste すると文字化け / dropped char。

### 5.2 clipboard:write — clipboard manager intercept (#180 ClipboardWriteNotDelivered)

**目的**: clipboard manager (ClipDiary / Ditto / ClipboardFusion) が active な環境で `Set-Clipboard` 後の `Get-Clipboard` race による silent overwrite を実機検出。

**手順**:
1. ClipDiary または Ditto を起動、`clipboard manager active` 状態に
2. `clipboard({action:'write', text:'race-test-1'})` を高頻度連続呼出
3. response 観測: 一部 call で `code:"ClipboardWriteNotDelivered"` + suggest "clipboard manager intercept detected"
4. 連続呼出が race condition を誘発、確率的 detection が動作

**期待**: race detection で actionable typed code、suggest に clipboard manager pause / disable 指示。
**Anti-pattern**: silent ok:true で clipboard manager 経由 overwrite → 後続 paste で意図しない内容 landing (#180 同型)。

### 5.3 clipboard:write — DLP / RDP transcoding edge

**目的**: matrix §5.2 false-positive policy で justify された `clipboard manager / DLP / RDP / format conversion` 4 cause を実機確認。

**手順**:
- **DLP active**: Microsoft Purview / Symantec DLP で sensitive data filter active 状態 → credential 風文字列 (`'AKIA...'` AWS access key 形式 等) を `clipboard:write` → DLP block + ok:false + suggest
- **RDP transcoding**: RDP session 経由で host machine から target machine への paste → UTF-16LE → UTF-8 transcoding race → suggest "RDP clipboard redirection の transcoding が発生、再試行推奨"
- **format conversion**: Excel / Word から rich format paste → CF_TEXT / CF_UNICODETEXT / CF_HTML 多 format で format selection mismatch → degradation hint

**期待**: 各 cause で actionable suggest、root cause を agent が診断可能。
**Anti-pattern**: silent ok:true で format mismatch → paste で空 / 別形式 landing。

### 5.4 clipboard:write → clipboard:read round-trip chain

**目的**: clipboard:write の永続化を続く clipboard:read で UTF-16LE byte-equal full 検証する chain が agent flow として成立することを確認。

**手順**:
1. `clipboard({action:'write', text:'chain-test-😀'})` で write
2. 直後に `clipboard({action:'read'})` で read
3. response の `text` が exact match (絵文字含む)
4. **negative**: 別 app で Ctrl+C で別文字列を上書き → `clipboard:read` で観測 → write contract 上は完了 (chain は read 側 responsibility)

**期待**: clipboard は L4 ephemeral state、書込 → 即読戻し で contract 維持、後続干渉は read 側で観測。
**Anti-pattern**: write が read より遅延、または write の `verifyDelivery: delivered` が read で異なる → race / formatting bug。

---

## 共通操作上の note

- **PowerShell rapid spawning**: `clipboard:write` は内部で powershell.exe を起動 → Set-Clipboard / Get-Clipboard 連続呼出 ladder。spawn cost が支配的、rapid call では race 観測しやすい。
- **clipboard format**: Windows clipboard は multi-format simultaneous storage (CF_TEXT / CF_UNICODETEXT / CF_HTML / CF_RTF / 他)、`Set-Clipboard` は UNICODETEXT のみ書込、複合 format 環境では mismatch 発生。
- **PII 注意**: dogfood 中に accidentally credential / PII を clipboard に置かない、test 用 dummy 文字列のみ使用。
- **UTF-16LE byte-equal**: emoji (4 byte UTF-16) や 異字体 (combining char) も完全に保持される、normalize なし。
