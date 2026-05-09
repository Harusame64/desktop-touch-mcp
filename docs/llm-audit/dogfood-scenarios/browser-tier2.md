# Dogfood Scenarios — browser_* (Tier 2 carry-over from automated pin gap)

- Status: **manual / dogfood scenarios for Phase 3b execution audit**
- Date: 2026-05-09
- Origin: `docs/llm-audit/phase3b-execution-audit.md` §3.3 carry-over (Plan §6 acceptance 2 経路目)
- Scope: browser_* 6 actions のうち、Phase 3b automated pin gap が残る cell の実機 GUI / CDP 依存シナリオ。本 phase で actionable は **cell 27 browser_form error column のみ** (1 cell)
- Parent audit section: 本 doc は `phase3b-execution-audit.md` §3.3 (cell 23-28) の carry-over scenario。current scope は browser_form (cell 27) に限定、他 5 actions の error/edge/chain は automated pin で完全カバー
- Cross-link: Phase 2b の browser-related dogfood は scope 外 (Tier 1 軸でない)、本 doc は Tier 2 軸の唯一の browser dogfood

**Section numbering note**: 本 doc は §6.x で開始 (§1-§5 不在)。これは将来的に browser_click / browser_eval / browser_navigate / browser_fill / browser_open の 5 actions 専用 dogfood scenario が必要となった場合の予約 (§1-§5)。現在 Phase 3b では automated pin で完全カバー済のため empty。Phase 4 query 軸 audit / Phase 5 closure で追加判断。

---

## 6. browser_form (cell 27 error path SoT)

### 6.1 browser_form — read-only nature と error path delegation

**目的**: matrix §3.1 line 163 規範 "form field inspection is read-only" を実機確認。production-handler error path は CDP unavailability に delegation され direct error pin が design 上少ない、本 scenario が SoT。

**手順**:
1. Chrome を `--remote-debugging-port=9222` で起動、login form を含む page (例: GitHub login page) を開く
2. `browser_open({port: 9222})` で接続、tabId 取得
3. `browser_form({tabId, port, selector: 'form'})` 呼出
4. response 観測: `ok:true`、`fields[]` に各 input/select/textarea/button の name/type/id/value/hint/disabled/readOnly/label がフラット return
5. side-effect なし: form 状態 / focus / scroll など page 内 state は変化なし

**期待**: read-only inspection、page 状態 untouched。
**Anti-pattern**: form inspection が hidden side-effect (focus 移動 / scroll) を起こす → 後続 tool の前提状態を破壊。

### 6.2 browser_form — CDP unavailability error path (cell 27 error column SoT)

**目的**: cell 27 error column の dogfood SoT。read-only delegation で direct error path test 困難、CDP 接続切断時の typed code shape を実機確認。

**手順**:
1. Chrome を起動 (`--remote-debugging-port=9222`)、`browser_open` で接続
2. Chrome を **強制終了** (Task Manager / `Stop-Process`) → CDP endpoint 死亡
3. `browser_form({tabId, port: 9222, selector: 'form'})` 呼出
4. response 観測: `ok:false`、`code:'BrowserNotConnected'` (classify 経由)、suggest "Call browser_open again with launch:{} to reconnect"

**期待**: CDP 切断検出 + actionable suggest。
**Anti-pattern**: silent ok:true で empty fields[] return → caller が form 構造空と誤認、recovery path 不明。

### 6.3 browser_form — selector resolution edge (selector が form 外を指す)

**目的**: selector が `<form>` 要素外 / 部分要素を指す場合の挙動確認。

**手順**:
1. `browser_form({tabId, port: 9222, selector: '.unrelated-div'})` (form 外の class)
2. response 観測: `ok:true` だが `fields:[]` (empty)、または `code:'ElementNotFound'`

**期待**: form-shaped element 不在で empty fields[] or typed error、silent partial 不可。
**Anti-pattern**: form 外の input をかき集めて return → caller が form fields と誤認。

### 6.4 browser_form → browser_fill chain (form discovery + fill 連鎖)

**目的**: matrix §3.1 line 163 prefer pattern "Use this before browser_fill to discover exact field selectors" を実機確認。

**手順**:
1. `browser_form({tabId, port, selector: 'form#login'})` で fields 取得
2. response の各 field の `selector` (or unique id) を次 tool に feed
3. `browser_fill({tabId, port, selector: '<step2 selector>', value: 'testuser'})` で input
4. `browser_fill` response の `actual` 値が input value と一致することを確認

**期待**: form discovery → fill chain で typed selector path、stable across page repaint。
**Anti-pattern**: `browser_form` 出力を agent が再判読せず global search bar 等 wrong field を target → password が search field に landing。

---

## 共通操作上の note

- **read-only design**: browser_form は副作用ゼロ、reactive UI / dirty state には影響なし。だが page を別 tool で操作中なら DOM mutation で fields 内容が変わる場合あり、`tabId + port` の context を毎回確認推奨。
- **hidden field exclusion**: default は `type=hidden` を skip、`includeHidden: true` で取得 (CSRF token / session id 等)。security 観点で sensitive data の expose に注意。
- **value text 200 chars truncation**: long textarea / pre-filled long content で truncation あり、full text は `browser_eval` で `element.value` 直接 read を推奨。
- **Phase 4 query 軸予定**: 本 scenario は Tier 2 commit 軸 audit の一部、browser_form は厳密には side-effect なし に近い query 性質、Phase 4 で query 軸として再 audit 予定。
