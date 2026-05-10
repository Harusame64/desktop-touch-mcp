# ADR-014: Cooperative in-pane bridge for Windows Terminal — 本物 BG (foreground 非奪取) を named pipe + helper module で実現

- Status: **Draft (Open question — 着手時期 v1.5.0+ stretch、Option E land 後の dogfood feedback 駆動)**
- Date: 2026-05-10
- **Re-review trigger date**: 2026-11-10 (= 2026-05-10 + 6mo、本日付までに着手判断 / Reject 判断のいずれもなければ ADR を再 review し、Roadmap を更新するか Status: Rejected で close する)
- Authors: Claude (Sonnet draft、pending Opus + Codex + user reviews、project `desktop-touch-mcp`)
- Related:
  - ADR-013 (`docs/adr-013-wt-bg-input.md` v1.4.6、§3.6 Option F outline + §7 OQ #9 を本 ADR で本実装化)
  - issue #173 (parent audit、WT silent fail discovery)
  - issue #185 (closed 2026-05-10、ADR-013 Phase 4 stretch tracking、Option E land で完遂)
  - PR #240 / PR #241 / PR #242 (v1.4.2 release、Option E `foreground_flash` channel 本実装)
  - memory `feedback_clipboard_flash_design_pitfalls.md` (Option F 提案根拠 + Option E v2 review lesson)
  - `src/engine/background-channel-resolver.ts` (`BackgroundInputChannel` discriminated union に `cooperative_bridge` variant が将来形のみ予約済、resolver は現在 narrow reject)
- Blocks: なし (Option E `method:'foreground_flash'` が短期解として live、本 ADR 不在でも production blocking なし)
- Blocked by: 本 ADR の決定 (Phase 0 protocol design spike → Phase 1 POC → Phase 2 本実装、§2 / §8 参照)

---

## 1. Context

### 1.1 Background — Option E land 後の "妥協 BG" vs "本物 BG" 役割分担

ADR-013 Phase 4 stretch (issue #185) は v1.4.2 release で **Option E (`foreground_flash` channel)** として land。これは Windows Terminal (WinUI/XAML pipeline、`CASCADIA_HOSTING_WINDOW_CLASS`) への BG injection を **clipboard + foreground steal ladder + paste warning scan** の組合せで実現する **妥協 BG path**。明示 opt-in (`method: 'foreground_flash'`) で `background` 契約 (= "foreground 奪取しない") とは契約上分離、`canInjectViaPostMessage(WT)` は引き続き `{supported:false, reason:"wt_xaml_pipeline"}` を維持して silent-success 構造的回避 (issue #173 が motivate した invariant) を保つ。

しかし Option E は本質的に **妥協** であり、以下の制約を caller に課す:

| 制約 | 実害 (dogfood 観測候補) |
|---|---|
| ~50-80ms (実測 mean 97-203ms) の foreground 一時占有 | user の作業中操作と競合、誤入力 risk |
| typing leak risk (flash 中の物理キーボード入力が WT に流入) | spike Round 2 で実測 (`docs/wt-bg-spike-round2-findings.md` §3.F-4)、kbd_hook で mitigation 可能だが Alt+Tab 等 block で default OFF |
| clipboard 一時占有 (HGLOBAL 系のみ復元、画像 / メタファイル復元不可) | user が画像 clipboard を保持中の Option E 使用で画像消失 |
| single-line + UTF-16 < 5KiB 制約 | 複数行 / 大量 text の 1 回 inject 不可、caller は手動分割が必要 |
| 並列 BG injection 不可 | foreground 占有が serialize、複数 WT tab 同時投入は Option E 単独では不可 |

これらの制約は ADR-013 §3.5 / §4 / §6 で明文化済、`docs/adr-013-followups.md` §2.10 (flash duration optimization) / §3.4 (design review fallback) でも追跡。Option E は **短期解** として位置付けられ、長期本命候補として **Option F (cooperative in-pane bridge)** が ADR-013 §3.6 outline で予約された (本 ADR の起草対象)。

### 1.2 制約 trade-off — Option F が本物 BG を実現する条件

ADR-013 §3.6 で integrated 済:

| 機能 | Option E foreground_flash | Option F cooperative bridge |
|---|---|---|
| WT 内表示更新 | ✓ (clipboard paste 反映) | ✓ (helper が同 pwsh 内 host process で実行) |
| foreground 奪取 | ✓ (~50-80ms 一時占有) | **✗ (奪取ゼロ、本物 BG)** |
| clipboard 副作用 | あり (HGLOBAL round-trip + 画像復元不可 + 3 point race detect) | **なし (clipboard 触らない)** |
| typing leak risk | あり (flash 中 keystroke 流入、kbd_hook で mitigation 可能だが default OFF) | **なし (foreground 切替なし)** |
| 並列 BG | 中 (foreground 占有が serialize) | **高 (multiple bridge 同時可)** |
| user opt-in | `method:'foreground_flash'` 明示 | helper module 起動 + DTM bridge 接続 |
| Microsoft 意思整合 | ✓ (公式 Win32 + UIA API のみ) | ✓ (named pipe = 完全公式 API) |
| WT 更新 / CFG 強化耐性 | 中 (clipboard / foreground stack の挙動依存) | **高 (named pipe は WT 内部 API 非依存)** |
| 既存任意 WT pane への接続 | ✓ (任意 WT window) | **✗ (helper 起動済 pane のみ、opt-in / managed session)** |
| 実装規模 (推定) | 中 (`src/win32/foreground_flash.rs` ~830 line + test、本 PR 完了) | **大 (helper module 配布 + protocol + lifecycle + fallback、4-7 週間、最大 8 週間)** |

Option F の **唯一の制約**は「既存任意 pane ではなく opt-in / managed session」になる点。これは agent flow 設計に影響する:
- agent が **任意 WT を見つけて** BG inject したい → Option E (foreground_flash) 一択
- agent が **特定 helper pane を持つ** WT に対して safe BG operation を行いたい → Option F が最適 (本物 BG + 並列性 + 副作用ゼロ)
- 実用パターンは併用 (helper 起動済 pane → Option F、helper 未起動 pane → Option E fallback)、本 ADR §3.x で fallback ladder を design

### 1.3 Cooperative bridge 採用根拠 — security / stability / Microsoft 意思整合

ADR-013 §3.6 で identified、本 ADR §3 で詳述する三つの decision driver:

1. **Security**: Microsoft 公式 `microsoft/terminal#9368` (Reject) 同型の "任意 app が任意 WT に command 注入" risk を **構造的に回避**。helper が pane 内で **明示起動** + named pipe **nonce** + **`CurrentUserOnly` ACL** で接続認証 → caller が helper を持たない pane に到達できない invariant。
2. **Stability**: named pipe は Win32 完全公式 API (`CreateNamedPipe` / `ConnectNamedPipe` / `WriteFile` / `ReadFile`)、WT 内部 API / undocumented hook に一切依存しない。WT 自身が CFG (Control Flow Guard) / AppContainer 強化しても影響なし、WT update で broken なし、Windows version 跨ぎで stable。
3. **Microsoft 意思整合**: Option D (`microsoft/terminal#9368` の laffo16 PR `#20106`) は Microsoft が Reject、根拠は "arbitrary process が任意 WT に command 注入できる security risk" で `CurrentUserOnly` ACL 等 mitigation でも公式採用に至らず。Option F は **明示 opt-in helper** によりこの security objection を構造的にクリア (任意 process が任意 WT に到達不可)、Microsoft 政策と非衝突。

これらは ADR-013 §3.6 の trade-off table で評価済 (`公式 API ✓` + `Microsoft 意思整合 ✓` + `WT 更新耐性 高` + `user 信頼 高` + `Microsoft Reject 該当なし`)。本 ADR は §3.6 の判断を **chosen direction として確定**、内部 design (protocol / 配布 / nonce / fallback) を Phase-gated で詰める。

---

## 2. Decision: 本 ADR は **Draft**、3 phase で順次決定

- **本 ADR では決定しない** (Status: Draft)
- 採用方針は §3 で named pipe + helper module を **chosen direction** として確定、alternative transport (WebSocket / gRPC / COM) は §3.2 で reject 理由明記
- **Phase 0**: **Protocol design spike** — pipe message format / nonce 管理 / lifecycle / fallback chain の design + 簡易 hello-world POC (§3.1)
- **Phase 1**: **POC 実装** — production-like helper + DTM MCP layer + Option E fallback ladder + `tests/e2e/cooperative-bridge-verification.test.ts` (§5.2)
- **Phase 2**: **本実装** — production helper 配布 + protocol stable contract + 既存 negative test の positive 化 + ADR Status flip (§5.3)

### 2.1 着手時期の判断軸 (advisory)

- **着手 trigger**: 以下のいずれかが満たされた時
  - Option E `foreground_flash` の dogfood 1-2 週間で foreground 占有 / typing leak / clipboard 副作用が agent flow を実質劣化させる事例が観測される
  - 並列 WT injection (複数 tab 同時 BG inject) が anti-fukuwarai workflow で不可避になる
  - dogfood feedback で "WT pane に長時間 helper を待機させて safe BG operation がしたい" 要求が複数 user から集まる
- **着手 skip 条件** (本 ADR を **Rejected** で close すべき場合):
  - Option E が dogfood で十分機能、user friction が観測されない (foreground 占有 / typing leak / clipboard 副作用がいずれも agent flow を劣化させない)
  - WT 自体が Microsoft 側で公式 BG input API を提供 (e.g. WinUI accessibility automation の正式拡張、ConPTY write API の WinRT 公式化)
  - Phase 0 で named pipe protocol / 配布 design が想定外に複雑化、coverage より maintenance cost が大きいと判定

---

## 3. Options

### 3.1 Option F-A: Named pipe + helper module (chosen direction)

**位置付け**: ADR-013 §3.6 推奨、本 ADR §1.3 三つの decision driver (security / stability / Microsoft 意思整合) を満たす唯一の transport。本 ADR で chosen direction として確定、§3.2 / §3.3 / §3.4 alternatives は reject 理由明記。

**仕組み概要**:

```
[Claude Code MCP server (Node.js child process)]
  │
  │ tools (keyboard:type / terminal:send) with method:'cooperative_bridge'
  │   ├─ resolveBackgroundInputChannel(hwnd, {allowedChannels:['cooperative_bridge', 'clipboard_flash']})
  │   │    → return {kind:'cooperative_bridge', pipeName:'\\.\pipe\dtm-bridge-<nonce>', helperPid, ...}
  │   └─ injectViaCooperativeBridge(channel, text, opts)
  │
  │ named pipe (CurrentUserOnly ACL + nonce auth)
  ▼
[DTM bridge helper (PowerShell module / standalone exe)]
  │ running inside the user's WT pane (= same pwsh / cmd / wsl host process)
  │ listens on \\.\pipe\dtm-bridge-<nonce>
  │
  │ accepts JSON Lines protocol (§3.1.2)
  │   ├─ "type" command → write text to host stdin, optional Enter
  │   ├─ "send" command → write text + Enter (terminal:send semantics)
  │   ├─ "ping" command → liveness check
  │   ├─ "shutdown" command → graceful pipe close + helper exit
  │   └─ "version" command → handshake, helper protocol version exchange
  │
  ▼
[host shell (pwsh / cmd / wsl) inside WT pane]
  │ visible output reflected in WT terminal display
  │ command executed in user's session, foreground unchanged
```

**Decision drivers (詳細)**:

1. **security**: helper が **明示起動済** pane のみ named pipe を listen、caller が任意 WT に到達不可。**nonce** (16 byte cryptographically random) は helper 起動時に生成、Claude MCP server に **out-of-band** で伝達 (= helper 起動コマンド出力 / `%USERPROFILE%\.desktop-touch-mcp\bridges\<nonce>.json` discovery file)。**`CurrentUserOnly` ACL** で他 user 接続を構造的に block。
2. **stability**: Win32 named pipe API (`CreateNamedPipe` / `ConnectNamedPipe` / `WriteFile` / `ReadFile` / `CloseHandle`) は OS-stable、WT 内部 API / undocumented hook に一切依存しない。WT update / CFG 強化 / AppContainer / Windows version migration いずれも non-issue。
3. **Microsoft 意思整合**: `microsoft/terminal#9368` reject の核心 ("arbitrary process → arbitrary WT") を構造的に回避 (helper 起動済 pane のみ接続)、`CurrentUserOnly` ACL で per-user isolation。

**Cons (本 ADR §6 で risk として詳述)**:

- 「既存の任意 pane」ではなく **opt-in / managed session**: ユーザーが事前に DTM helper を起動する必要 → onboarding friction、helper 未起動時の caller 経験を fallback ladder で mitigation
- helper 配布方式: §3.5 で 4 候補 (npm separate / PS module / standalone exe / hybrid) を比較
- protocol message format: §3.6 で 3 候補 (JSON Lines / MessagePack / custom binary) を比較
- protocol version compat: helper / MCP server の SemVer handshake design (§3.7)
- nonce 管理 lifecycle: per-process / per-session / per-pipe + cleanup 規約 (§3.8)

### 3.2 Option F-B: WebSocket loopback (REJECTED)

**仕組み**: helper が `127.0.0.1:<port>` で WebSocket server を listen、MCP server が `ws://127.0.0.1:<port>` で接続、JSON message 交換。

**Reject 理由**:

- **AV 反応 risk**: loopback でも TCP socket open は Windows Defender / 一部 enterprise AV の heuristic で reflective tooling と判定される確率 (Option D Phase 0 検証で観測済 ADR-013 §3.0 同型 risk)
- **Microsoft Defender Application Control (WDAC)**: 一部 enterprise 環境で `127.0.0.1` socket open が policy block される可能性、named pipe は同 policy で通常 allow
- **port collision**: helper instance 複数起動時の port allocation 設計が複雑、named pipe は名前空間で natural multiplex
- **nonce 認証の弱化**: WebSocket は port number が広く discoverable、named pipe は名前空間 + ACL で **構造的** に user-only restrict
- **API surface 増**: WebSocket library 依存追加、Node.js 標準 `net` (named pipe) で済むものが additional dep

**比較における劣位**: Option F-A の "完全公式 API + AV 反応低 + nonce 認証強" を満たさない。Microsoft 意思整合と stability の観点で named pipe が一段上、本 ADR は Option F-B を採用しない。

### 3.3 Option F-C: gRPC + helper module (REJECTED)

**仕組み**: helper が gRPC server を立ち上げ、MCP server が gRPC client で接続、Protocol Buffers message 交換。

**Reject 理由**:

- **依存重い**: gRPC / Protocol Buffers の Node.js client (`@grpc/grpc-js` + `@grpc/proto-loader`) は 数 MB の bundle 増、現 launcher 32.4 KB + 本 ADR helper の二重肥大化を avoid したい
- **学習コスト + maintenance**: .proto schema 管理 + version compat handshake + bidirectional streaming semantics、本 ADR の use case (single-line text inject + ping + shutdown) には over-engineered
- **Windows 環境 fit が中**: gRPC は Microsoft の `.NET` 系 tooling で標準だが、PowerShell module / standalone exe 配布で gRPC server を持たせる成熟例が少ない (= debugging friction)
- **named pipe / WebSocket より複雑**: protocol design の設計余地が広すぎ、Phase 0 spike の scope 拡散 risk

**比較における劣位**: Option F-A の "small dep + simple semantics + named pipe stability" に比し overhead 大、本 ADR は Option F-C を採用しない。

### 3.4 Option F-D: COM IPC (REJECTED)

**仕組み**: helper が COM server (`IDtmBridge`) を register、MCP server が CoCreateInstance + invoke method。

**Reject 理由**:

- **registry pollution**: COM server registration は `HKEY_CURRENT_USER\Software\Classes\CLSID\{guid}` を要、user 環境の registry 干渉が disinvited
- **apartment threading 複雑**: STA / MTA / NTA / 同期 vs 非同期、bug catch 難 (Option E `clipboard_snapshot.rs` でも触れた COM apartment threading 教訓、`feedback_clipboard_flash_design_pitfalls.md` Option F 直前の v2 review)
- **Windows-only かつ deprecated path**: Microsoft 自身が新規 IPC を named pipe / WebSocket / gRPC に推奨、COM IPC は legacy 系 maintenance のみ
- **PowerShell module / Node.js 連携が薄い**: PowerShell の COM 操作は中庸 (`New-Object -ComObject`) だが Node.js 側は `node-ffi` 系 + 手書き interface bind で重い
- **debug / inspect 困難**: COM transactions は OleView 等専用 tool で観察、named pipe は `pipelist` / WireShark localhost pipe / 自前 dump で簡易

**比較における劣位**: Option F-A の "no registry / no apartment / debuggable / Microsoft 推奨" に比し劣位、本 ADR は Option F-D を採用しない。

### 3.5 Helper 配布方式 (Option F-A 内 sub-decision、§3.5.x で 4 候補比較)

helper の配布手段は本 ADR § Phase 0 spike で実機評価、§5.0 acceptance に従い決定:

| 候補 | size | signing 必要性 | Defender 反応 | ExecutionPolicy 影響 | version sync 複雑度 |
|---|---|---|---|---|---|
| **F-A-1**: npm separate package (`@harusame64/desktop-touch-mcp-bridge`) | npm dl 数 MB | 不要 (npm package) | 低 (PS script) | `Restricted` で fail | 低 (npm tag 揃え) |
| **F-A-2**: PowerShell module (`Install-Module DTM-Bridge`) | PowerShell Gallery | 不要 (PS Gallery 検証) | 低 (公式 PS Gallery) | `Restricted` で fail | 中 (PS Gallery + npm 二重 publish) |
| **F-A-3**: standalone exe (single-binary、Rust 製) | exe ~5-10 MB / 配布 = npm bundle / GH Release | **必須** (SmartScreen 警告 reduce) | 中 (unsigned exe は SmartScreen 警告) | 影響なし | 中 (GH Release tag 揃え + 署名手順) |
| **F-A-4**: hybrid (PS script default + standalone exe opt-in) | combined | 部分必須 | 低 (PS) → 中 (exe) | 部分影響 | 高 (二重 distribution + fallback chain) |

**Phase 0 spike 評価軸** (§5.0 acceptance):
1. 実機での起動成功率 (5 環境: standard user / admin / `Restricted` ExecutionPolicy / Defender Real-time / Windows Sandbox)
2. SmartScreen 警告発生率 (unsigned exe での体感負担)
3. version sync の複雑度 (npm / PS Gallery / GH Release tag 整合)
4. `npm publish` workflow への影響 (現 release-process.md の流れに helper 配布が追加で何 step 必要か)

**preliminary recommendation** (Phase 0 検証前の暫定): F-A-1 (npm separate package) が **lowest friction** baseline、`Restricted` ExecutionPolicy 環境のみ F-A-3 (standalone exe) fallback。F-A-4 hybrid は version sync の複雑度が高い、Phase 0 結果次第で reject 候補。

### 3.6 Protocol message format (Option F-A 内 sub-decision、§3.6.x で 3 候補比較)

| 候補 | size overhead | parse cost | debug 容易性 | Node.js 標準対応 |
|---|---|---|---|---|
| **F-A-α**: JSON Lines (newline-delimited JSON) | 中 (key 名 overhead) | 低 (`JSON.parse`) | **高** (text editor で直 view) | ✓ (built-in) |
| **F-A-β**: MessagePack | **低** (binary efficient) | 中 (msgpack-lite dep) | 低 (binary inspect 必要) | ✗ (npm dep) |
| **F-A-γ**: custom binary (header + payload) | **最低** | 中 (手書き parser) | 低 (hex dump 必要) | ✗ (手書き) |

**preliminary recommendation**: **F-A-α (JSON Lines)** が lowest implementation friction + debug 容易性 + Node.js 標準対応。本 ADR の use case (single-line text inject + ping + shutdown + version handshake) は size overhead が問題にならない、binary 最適化は不要。Phase 0 で確定。

**JSON Lines schema 概要** (Phase 0 spike で決定):

```jsonc
// MCP server → helper (request)
{"id":"req-1","method":"type","params":{"text":"...","pressEnter":true,"timeout_ms":5000}}
{"id":"req-2","method":"ping","params":{}}
{"id":"req-3","method":"version","params":{}}
{"id":"req-4","method":"shutdown","params":{}}

// helper → MCP server (response)
{"id":"req-1","result":{"ok":true,"bytes_written":15,"reflected_in_terminal":true}}
{"id":"req-1","error":{"code":"timeout","message":"host stdin write timed out"}}

// helper → MCP server (server-initiated event、Phase 1+ optional)
{"event":"helper_shutting_down","reason":"user_pane_closed"}
```

### 3.7 Protocol version handshake (Option F-A 内 sub-decision)

helper / MCP server の version mismatch を構造的回避:

- **handshake**: 接続直後に MCP server が `{"id":0,"method":"version","params":{}}` を送信、helper が `{"id":0,"result":{"protocol":"1.0","helper_version":"1.4.2","supported_methods":["type","send","ping","shutdown","version"]}}` で返答
- **SemVer rule**: `protocol` major version mismatch は immediate disconnect + caller fail (`CooperativeBridgeProtocolMismatch` typed reason)、minor / patch mismatch は graceful (新 method を送らない)
- **fallback**: handshake 失敗 / timeout (default 5s、**Phase 0 で実測 + 必要に応じて 1s 程度に narrow 検討、OQ #3、P2-2 Round 1 fix**) は `cooperative_bridge_handshake_failed` で fail、§3.9 fallback ladder へ degrade。local pipe (network latency なし) で 5s は通常余裕すぎ、debugger / breakpoint 中の helper を考慮しつつ p99 + safety margin で確定

### 3.8 Nonce 管理 lifecycle (Option F-A 内 sub-decision)

- **生成**: helper 起動時に 16-byte cryptographically random nonce を生成、**hex encode (32 hex chars baseline、P2-3 Round 1 fix)** で file 名に使用、`%USERPROFILE%\.desktop-touch-mcp\bridges\<nonce-hex>.json` に discovery file 書き出し (`{nonce, helperPid, pipeName, startedAt, version}`)。代替案として `<helperPid>-<nonce-hex-prefix-8chars>.json` (human-debuggable) も Phase 0 で評価候補
- **生存期間**: helper process 生存中のみ (`per-process` lifetime)、helper exit 時に discovery file 削除 + named pipe close
- **discovery**: MCP server は `~\.desktop-touch-mcp\bridges\` を `fs.readdir` で scan、`helperPid` が live (`process.kill(pid, 0)` で TRUE) かつ `version` が compatible なものを candidate list、user が `windowTitle` / `hwnd` で specifier 与えれば該当 helper の pipe で接続
- **rotation**: helper 再起動時に新 nonce 生成、旧 discovery file は helper graceful shutdown で削除 / 異常終了時は MCP server scan で `pid not alive` → discovery file expire (24h 以上 / `pid not alive` のいずれかで cleanup)
- **leak 防止**: `~\.desktop-touch-mcp\bridges\` cleanup utility (`scripts/cleanup-stale-bridges.mjs`) を Phase 1 で同梱、`npm run cleanup-stale-bridges` で manual sweep 可能

### 3.9 Fallback ladder (Option F-A + Option E + foreground 既存)

caller が `method:'cooperative_bridge'` を指定したとき、resolver は以下の優先度で channel を選定:

```
1. cooperative_bridge (helper 起動済 + nonce 認証成功 + version compat)
   → 成功 path: 本物 BG (foreground 非奪取)
   → 失敗 path:
     a) helper 未起動 (pid not alive)            → degrade to clipboard_flash (Option E)
     b) handshake timeout (5s)                   → degrade to clipboard_flash
     c) protocol major version mismatch           → fail with CooperativeBridgeProtocolMismatch
     d) nonce 認証失敗                            → fail with CooperativeBridgeAuthFailed (security violation)

2. clipboard_flash (Option E、ADR-013 v1.4 land 済)
   → ADR-013 §3.5 既存 fallback ladder に従う

3. foreground (既存 SendInput foreground path)
   → caller が明示 fallback として指定した場合のみ
```

caller が `method: 'cooperative_bridge_strict'` (= 別 method、bridge 失敗時 fail with no degrade) を指定した場合は a/b でも fail を返す → caller が「foreground 奪取を一切許容しない agent flow」を構成可能。

**Silent degrade 構造的回避 (北極星整合、P1-3 Round 1 fix)**:

a) / b) path で silent に `clipboard_flash` (Option E foreground 一時占有) に degrade すると、caller 期待値 (本物 BG) と実挙動 (妥協 BG) の drift が生じ得る。issue #173 silent-success 構造的回避の同型 risk を防ぐため、**a) / b) degrade 時は必ず以下の typed surface を返す** (Phase 1 acceptance §5.1 必須):

- `hints.fallbackUsed: true` (boolean、degrade 発火を観測可能化)
- `hints.fallbackChannel: "clipboard_flash"` (degrade 先 channel 明示)
- `hints.fallbackReason: "helper_not_running" | "handshake_timeout"` (typed enum、各 case 区別)
- `hints.fallbackForegroundOccupiedMs?: number` (Option E 経路の実 foreground 占有時間、observability)

**Default method 反転検討 (OQ #5 で Phase 1 確定)**: 「本物 BG 期待 caller の default 安全」観点で `method:'cooperative_bridge'` が permissive default (silent degrade 許容) ではなく strict default (helper 未起動なら fail) のほうが北極星整合。Phase 1 spec で以下のいずれかを user 判断で確定:
- **(α) 現案**: `method:'cooperative_bridge'` = permissive (default、silent degrade 可) / `method:'cooperative_bridge_strict'` = no degrade (opt-in)
- **(β) 反転**: `method:'cooperative_bridge'` = strict (default、no degrade) / `method:'cooperative_bridge_permissive'` = silent degrade 許容 (明示 opt-in)
- **(γ) field**: `method:'cooperative_bridge'` + `allowFallback: true | false` (default `false`) で field flag

OQ #5 で Phase 1 確定、本 ADR では default は (β) strict-default が北極星整合観点で推奨 baseline (= caller が明示しない限り foreground 占有 fallback には到達しない)。

---

## 4. Trade-off comparison

§3 で identified された Option F-A (named pipe + helper) を確定方針として、§3.2 / §3.3 / §3.4 alternatives との比較:

| 観点 | F-A. named pipe (chosen) | F-B. WebSocket | F-C. gRPC | F-D. COM IPC |
|---|---|---|---|---|
| 公式 API | ✓ (Win32 完全公式) | ✓ (TCP loopback) | ✓ (Microsoft 推奨) | ✓ (legacy) |
| 実装規模 | 中 (4-7 週間、最大 8 週間) | 中-大 | 大 (proto + grpc dep) | 大 (COM apartment) |
| WT 内表示更新 | ✓ (helper が host shell 内実行) | ✓ | ✓ | ✓ |
| foreground 奪取 | ✗ (本物 BG) | ✗ | ✗ | ✗ |
| user opt-in 要 | ✓ (helper 起動) | ✓ | ✓ | ✓ |
| 実機動作確実性 | 高 (named pipe stable) | 中 (AV 反応 risk) | 高 (但し Node.js 連携 friction) | 低 (apartment threading) |
| Windows version 跨ぎ | 高 | 中 (Defender policy 変動) | 中 | 低 (legacy path) |
| user 信頼 | 高 (公式 API + opt-in helper) | 中 (loopback socket は誤判定 risk) | 中 (heavy dep) | 低 (registry pollution) |
| AV 反応 risk | 低 | **中** (loopback heuristic) | 低 | 低 |
| 並列 BG 性能 | 高 (per-helper independent) | 高 | 高 | 中 |
| Microsoft 意思整合 | ✓ (named pipe = 推奨 IPC) | ✓ (TCP は OS-level) | ✓ (.NET MAUI 標準) | ✗ (legacy maintenance) |
| Status (本 ADR) | **chosen direction** | Rejected | Rejected | Rejected |

**v1 ranking 結果**:
- **F-A**: chosen direction、§3 / §5 / §6 全節を本 option 中心に記述
- **F-B / F-C / F-D**: §3.2 / §3.3 / §3.4 で reject、本 ADR で再検討しない (将来 F-A 採用が技術的に成立しなかった場合のみ revisit)

---

## 5. Acceptance criteria (各 phase の to-be 状態)

### 5.0 Phase 0 acceptance (Protocol design spike + 配布方式実機評価)

§3.5 / §3.6 / §3.7 / §3.8 / §3.9 sub-decision を実機 spike で確定:

- [ ] **配布方式 4 候補 (F-A-1 / F-A-2 / F-A-3 / F-A-4) を実機 spike**: 5 環境 (standard user / admin / `Restricted` ExecutionPolicy / Defender Real-time / Windows Sandbox) で起動成功率 + SmartScreen 警告率 + version sync 複雑度を計測、§3.5 table embed
- [ ] **protocol format 3 候補 (F-A-α / F-A-β / F-A-γ) を簡易 hello-world POC**: 1000 message/s での parse cost + debug 容易性を比較、§3.6 で確定
- [ ] **named pipe + nonce + ACL 簡易 POC**: helper (PowerShell script) 起動 → discovery file 書き出し → MCP server scan → 接続 → handshake → "ping" 1 cycle、Phase 0 の minimal happy path 確認
- [ ] **fallback ladder 設計 confirm**: §3.9 のロジックを TS 側 design doc (`docs/adr-014-phase0-spike.md` で本 ADR とは別 file、**Phase 0 着手 PR で新規生成、本 ADR-014 PR では作成しない、P3-1 Round 1 fix**) に書き出し、Phase 1 へ baseline 提供

### 5.1 Phase 1 acceptance (POC 実装)

- [ ] **helper module 本実装**: §5.0 で確定した baseline 配布方式 (1 つ、Phase 0 evidence 駆動) + 必要に応じて §5.0 で hybrid 構成 (本 phase は Phase 0 確定 baseline で focused、§5.0 acceptance 結果が Phase 1 input 必須 = §3.2 carry-over scope shrink 不在原則)
- [ ] **DTM MCP layer 実装**: `src/engine/cooperative-bridge.ts` + `src/engine/background-channel-resolver.ts` の `cooperative_bridge` variant を **現状 (Phase 1 land 前): allowedChannels で `cooperative_bridge` 指定でも resolver は `kind:"unsupported"` を返す = caller fail (P2-6 Round 1 fix)** → Phase 1 land で live channel flip、`injectViaCooperativeBridge` 実装で初めて public surface 拡張 (= carry-over scope 完結)
- [ ] **fallback ladder 実装**: §3.9 のロジックを TS 側で実装、`method:'cooperative_bridge'` で a/b/c/d 全 case を unit test pin
- [ ] **typed surface 検証 (P1-3 Round 1 fix、北極星整合 必須)**: §3.9 a) / b) silent degrade 経路で `hints.fallbackUsed: true` + `hints.fallbackChannel: "clipboard_flash"` + `hints.fallbackReason: "helper_not_running" | "handshake_timeout"` + `hints.fallbackForegroundOccupiedMs?` が必ず付くことを 4 unit test (a-success-with-fallback / b-success-with-fallback / a-fail-strict / b-fail-strict) で pin
- [ ] **POC E2E test**: `tests/e2e/cooperative-bridge-verification.test.ts` で WT helper 起動 + Claude MCP server 接続 + `keyboard:type method:'cooperative_bridge'` で `ok:true, hints.backgroundChannel:'cooperative_bridge', hints.fallbackUsed: false` 返却
- [ ] **既存 negative test の影響**: `tests/e2e/keyboard-bg-verification.test.ts` / `tests/e2e/foreground-flash-verification.test.ts` の WT scenario は **変更なし** (= `method: 'background'` / `method: 'foreground_flash'` 契約は不変、新 `method: 'cooperative_bridge'` のみ追加)

### 5.2 Phase 2 acceptance (本実装、release readiness)

- [ ] **helper 本格配布**: Phase 0 で確定した配布方式 (F-A-1 baseline + 必要に応じて F-A-3 hybrid) を production 化、`docs/cooperative-bridge-helper-install.md` で installation guide 整備
- [ ] **`docs/operation-verification-matrix.md` §3.1 / §4.3 update**: WT BG path 規範を新 channel に拡張、`cooperative_bridge` reason enum 追加
- [ ] **CHANGELOG 記載**: v1.5.0+: `method:'cooperative_bridge'` introduction + 既存 `method:'background'` / `method:'foreground_flash'` 契約 不変、breaking change なし
- [ ] **WT default-on E2E pass**: `tests/e2e/cooperative-bridge-verification.test.ts` で 100 連続 BG injection 全 success (flaky < 1%、helper 起動済 pane 限定で実行)。**実行環境**: §5.0 Phase 0 で起動成功した環境のうち **standard user baseline で必須**、enterprise 環境 (WDAC / AppLocker / Group Policy 干渉) は §6.2 / OQ #10 で future PR carry-over (P2-5 Round 1 fix)
- [ ] **stress test**: 連続 1000+ injection は別 env / 別 flag で実施、`benches/adr014_cooperative_bridge_throughput.mjs` で latency / throughput 計測 (standard user baseline、enterprise 環境は別 PR scope)
- [ ] **helper version compat test**: helper old version + MCP server new version の handshake test (major mismatch で `CooperativeBridgeProtocolMismatch`、minor mismatch で graceful)
- [ ] **discovery file leak test**: helper 異常終了 (kill -9) 後の discovery file が MCP server scan で `pid not alive` 判定 + 24h 以上経過で expire、`scripts/cleanup-stale-bridges.mjs` で manual sweep 可能
- [ ] **ADR Status flip**: §1.3 三つの decision driver (security / stability / Microsoft 意思整合) が実機検証で confirm、§9 Decision History に "Status: Draft → Accepted" 記録

### 5.3 Out-of-scope

- WT 以外の WinUI host (将来の UWP-style terminal、新 PowerShell Preview 等) — 別 issue で扱う
- 既存 conhost path への bridge — `ConsoleWindowClass` 経路は本 ADR scope 外、Option E `wm_char` channel が引き続き対応
- elevated process (admin terminal) への helper 起動 — UIPI 制約で同 ADR scope 外、別 ADR 候補
- helper 起動の **完全 auto-discovery** (= user 操作ゼロで helper 配置) — 本 ADR scope は **opt-in / managed session**、auto-start option は §3.5 で carry-over (将来 PR で `wt profile` integration が成立すれば revisit)
- WT-internal WinRT API への接続 — Option F-A は **WT 内部 API 非依存**、helper が host shell 内 stdin write のみで動作、WT XAML pipeline 触らない (= ADR-013 §3.1 / §3.2 が NO-GO した経路と完全分離)

---

## 6. Consequences / Risks

### 6.1 Positive consequences (本 ADR の採用が成功した場合)

- **本物 BG 復活**: `method:'background'` 契約の "foreground 奪取しない" を helper 起動済 pane で **完全達成**、issue #173 v1.1.0 → v1.3.2 → v1.4.2 (Option E) → 本 ADR (Option F) の 4 stage 進化で WT BG path narrative 完成
- **agent 並列性**: 複数 WT pane に helper を配置すれば multiple bridge 同時 injection 可、anti-fukuwarai workflow 強化
- **Win11 SetForegroundWindow restriction 完全回避**: foreground 切替自体が発生しないため `ForegroundRestricted` 由来 fail rate ゼロ
- **clipboard / typing leak 副作用ゼロ**: helper が host shell 内 stdin write、user clipboard / kbd input に一切干渉せず
- **WT update 耐性**: named pipe + helper の組合せは WT 内部 API 非依存、Microsoft が WT XAML / TerminalControl 仕様を変更しても本 path に影響なし
- **Microsoft 意思整合**: `microsoft/terminal#9368` reject の "arbitrary process → arbitrary WT" risk を opt-in helper + nonce + ACL で構造的回避、Microsoft 政策と非衝突 narrative を docs に永続化

### 6.2 Risks (採用判断で重視する)

- **helper 配布の SmartScreen / Defender 反応**: 特に F-A-3 (standalone exe) 採用時、未署名 exe の SmartScreen 警告で user friction 発生 → §3.5 Phase 0 spike で実機評価、必要に応じて F-A-1 (npm) baseline に narrow
- **PowerShell ExecutionPolicy `Restricted`**: F-A-1 / F-A-2 (PowerShell-based) は `Restricted` 環境で fail、F-A-3 (standalone exe) fallback が必要 → §3.5 Phase 0 で 5 環境検証
- **helper 起動の onboarding friction**: opt-in / managed session の本質的制約、`docs/cooperative-bridge-helper-install.md` で installation guide + auto-start option (`wt profile` integration 候補) を documentation 充実
- **discovery file race / leak**: helper 異常終了 / 同時 multiple helper / nonce collision の race detection → §3.8 で 24h expiry + `pid not alive` cleanup を design、Phase 2 で stress test
- **protocol version drift**: helper / MCP server が独立配布だと version mismatch 発生確率増 → §3.7 SemVer handshake + major mismatch で immediate fail、Phase 2 で compat test
- **enterprise 環境 (WDAC / AppLocker)**: F-A-3 (standalone exe) は WDAC / AppLocker policy で block 可能性、Phase 0 spike で Windows Sandbox 検証だけでは不十分、enterprise environment での dogfood が future requirement
- **Microsoft.Terminal licensing**: 本 ADR は WT 内部 API / metadata vendoring 不要、helper 配布で WT licensing と接触なし (= Option F-A の structural advantage)
- **release timing**: v1.5.0+ stretch、間に他 feature が入って ADR が stale 化する risk → **header の Re-review trigger date: 2026-11-10 が binding marker**、本日付に達した時点で着手判断 / Reject のいずれかに decision flip 必須
- **Silent contract drift risk** (北極星整合、P1-3 Round 1 fix): `method:'cooperative_bridge'` permissive default では helper 未起動時に silent foreground 占有 (clipboard_flash degrade) に到達、caller の本物 BG 期待値と実挙動 drift。issue #173 (`method:'background'` silent-success) と同型 risk → §3.9 で `hints.fallbackUsed` / `hints.fallbackChannel` / `hints.fallbackReason` typed surface を必須化、OQ #5 で strict-default vs permissive-default vs field flag の design decision、北極星整合観点で **strict-default (β) を推奨 baseline** とする (caller 明示なしで foreground 占有 path に到達しない invariant)。Phase 1 確定で本項を Resolved 化、§5.1 acceptance に typed surface 検証を embed

---

## 7. Open Questions

1. **helper 配布方式 final 決定**: §3.5 Phase 0 spike 結果次第で F-A-1 (npm separate) baseline / F-A-3 (standalone exe) hybrid / F-A-2 (PS module) のいずれかに narrow、混合構成の version sync 複雑度が許容範囲かを Phase 0 で評価
2. **protocol format final 決定**: §3.6 Phase 0 spike で F-A-α (JSON Lines) を baseline 採用予定、binary 最適化 (F-A-β MessagePack) が必要になる規模感は本 ADR use case で発生しない見込み (single-line text + ping + shutdown のみ) だが Phase 0 で confirm
3. **handshake timeout の妥当値**: §3.7 で 5s default とした、network latency なしの local pipe で 5s は余裕すぎるが debugger / breakpoint 中の helper を考慮すると妥当か Phase 0 で評価
4. **discovery file 配置 path**: §3.8 で `%USERPROFILE%\.desktop-touch-mcp\bridges\` とした、roaming profile / OneDrive sync 環境での挙動を Phase 0 で確認 (write race / partial sync の影響)
5. **`cooperative_bridge` method の strict-default vs permissive-default 確定**: §3.9 で identified の 3 候補 (α permissive-default + strict opt-in / **β strict-default + permissive opt-in (推奨 baseline)** / γ field flag `allowFallback`) を Phase 1 で確定。北極星 (silent-success 構造的回避) 観点で **β** が推奨 (memory `feedback_clipboard_flash_design_pitfalls.md` 「契約名は spec 違反 vector の第一防御層」整合)、ただし permissive default (α) のほうが既存 `method:'background'` / `method:'foreground_flash'` semantics (= caller 期待値が明確な opt-in) との一貫性で優位な可能性も Phase 1 spec 議論で検討。確定後は `_errors.ts` SUGGESTS dictionary + matrix §3.1 + ADR-013 §3.5 hints `backgroundChannel` enum と整合させる SSOT sweep が Phase 1 acceptance に必須
6. **multiple helper / multiple WT window**: 同 user が複数 WT window に helper を起動した場合の resolver 動作、`windowTitle` / `hwnd` で disambiguation、ambiguous 時 fail vs 1 つ目に fallback どちらが安全か Phase 1 spike で評価
7. **helper protocol logging / observability**: helper 内 verbose log option (`DTM_BRIDGE_LOG_LEVEL=debug`) + log file rotation (`%USERPROFILE%\.desktop-touch-mcp\logs\bridge-<pid>-<date>.log`) の design、debug-friendliness と PII risk の trade-off、Phase 1 で結論
8. **helper auto-update**: helper version が独立配布だと auto-update mechanism 必要、Phase 2 では manual reinstall (`npm i -g @harusame64/desktop-touch-mcp-bridge` etc.) で MVP、auto-update は future PR (= breakable な mechanism なら本 ADR scope に含めない)
9. **WT pane 内 helper の lifecycle**: pane 閉じ → host shell exit → helper exit → discovery file cleanup の連鎖が確実に発生するか、helper を background job (`Start-Job`) で起動 vs foreground process で起動の trade-off、Phase 0 spike で確認
10. **enterprise 環境 dogfood**: §6.2 に書いた WDAC / AppLocker / Group Policy 干渉、本 ADR scope では Windows Sandbox + standard user environment までで Phase 2 acceptance、enterprise 環境での dogfood は future PR / 別 issue で扱う

---

## 8. Roadmap (advisory、決定は §2 Decision の 3 phase)

| Phase | 期間 | 出力 | acceptance |
|---|---|---|---|
| 1. ADR draft land | 1 PR (本 PR) | `docs/adr-014-cooperative-bridge.md` | docs review (Opus 1+ round + Codex 1+ round) + user review |
| 2. Phase 0 — Protocol design spike + 配布方式実機評価 | 1-2 週間 | spike branch + `docs/adr-014-phase0-spike.md` (Phase 0 PR で新規生成) + 5 環境 helper 起動成功率 + protocol format 確定 | §5.0 acceptance 全 ✓ |
| 3. Phase 1 — POC 実装 | 2-3 週間 | feature PR、helper module (Phase 0 確定 baseline) + DTM MCP layer + fallback ladder + POC E2E test | §5.1 acceptance 全 ✓ |
| 4. Phase 2 — 本実装 | 1-2 週間 | feature PR、production helper 配布 + protocol stable contract + WT default-on E2E + ADR Status flip | §5.2 acceptance 全 ✓ |
| 5. ADR Status 昇格 | 同 Phase 2 PR | `Status: Draft` → `Status: Accepted` + `Decision:` 節更新 | 本 ADR closure |

合計: Phase 0-2 全完走で **4-7 週間** (Phase 0 spike 結果次第で Phase 1 以降の選択肢が変動、最大 8 週間想定)。

---

## 9. Decision History

| Date | Status | Author | Rationale |
|---|---|---|---|
| 2026-05-10 | Draft (v1) | Claude (Sonnet draft) | ADR-013 §3.6 Option F outline + §7 OQ #9 の inline、Option E v1.4.2 release land 後の長期本命候補として起草。scope = named pipe baseline 確定型 (Option F-A)、F-B/C/D は §3 で reject 理由明記 |
| 2026-05-10 | Draft (v1.1、Round 1 Opus phase-boundary review apply) | Claude (Sonnet) + Opus Round 1 review | P1×3 (ADR-013 version reference v1.4.5→v1.4.6 / Phase 期間 numeric drift §1.2 §4 4-6→4-7 sync / §3.9 fallback ladder silent degrade typed surface 必須化 + §6.2 silent contract drift risk 追加 + OQ #5 strict-default 推奨 narrative) + P2×6 (§5.1 helper 配布方式 narrowing 飛び carry-over scope shrink fix / §3.7 handshake timeout 5s causal window narrow 検討 / §3.8 nonce hex encode 32 chars / ADR-013 §3.6 4-8→4-7 cross-doc drift sync / §5.2 stress test standard user baseline narrow / §5.1 carry-over narrative narrow reject 現状明示) + P3×4 (`docs/adr-014-phase0-spike.md` 前方参照 注記 / §1.2 ✓✗ inconsistency flip / `microsoft/terminal#9368` URL 直 link / §10 MIT 引用根拠注記) を全件反映。北極星 (silent-success 構造的回避) 整合観点で `method:'cooperative_bridge'` strict-default (β) を §6.2 / OQ #5 で推奨 baseline narrative 確定、Phase 1 spec 確定で Resolved 化 |
| (future) | Draft → Accepted | (TBD) | Phase 2 acceptance 全 ✓ + 実機検証で §1.3 三つの decision driver (security / stability / Microsoft 意思整合) が confirm、helper 配布の enterprise 環境 dogfood pass 後に user 判断で Accepted へ昇格 |
| (future) | Re-review trigger | 2026-11-10 | header の binding marker、本日に達した時点で必須 |

---

## 10. References

- ADR-013 (`docs/adr-013-wt-bg-input.md` v1.4.6、§3.6 Option F outline + §7 OQ #9)
- `docs/adr-013-followups.md` (Option E follow-up backlog、本 ADR の長期解 narrative と整合)
- `docs/adr-013-option-e-impl.md` v3 (Option E 本実装 plan、本 ADR Phase 1 fallback ladder の参考)
- issue #173 (parent audit、WT silent fail discovery)
- issue #185 (closed、ADR-013 Phase 4 stretch tracking)
- PR #240 / PR #241 / PR #242 (Option E land in v1.4.2)
- memory `feedback_clipboard_flash_design_pitfalls.md` (Option F 提案根拠 + Option E v2 review lesson 7 件)
- `src/engine/background-channel-resolver.ts` (`BackgroundInputChannel` discriminated union、`cooperative_bridge` variant が現在は narrow reject、Phase 1 で live channel に flip)
- Win32 Named Pipes: <https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes> (Microsoft 公式 API、本 ADR Option F-A の transport 採用根拠)
- `microsoft/terminal#9368` Microsoft Reject ("arbitrary process → arbitrary WT" security objection、本 ADR は opt-in helper + nonce + ACL で構造的回避): <https://github.com/microsoft/terminal/issues/9368>
- `microsoft/terminal#20106` laffo16 PR (Option D close 済、本 ADR scope 外): <https://github.com/microsoft/terminal/pull/20106>
- Microsoft.Terminal repository (MIT-licensed、**本 ADR は内部 vendoring 不要、引用は laffo16 PR / community discussion source として §1.3 / §3.0 / §6.2 narrative の根拠 link 経由で参照、P3-4 Round 1 fix**): <https://github.com/microsoft/terminal>
