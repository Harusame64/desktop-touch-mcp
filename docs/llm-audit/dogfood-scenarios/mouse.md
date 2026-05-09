# Dogfood Scenarios — mouse (mouse_click / mouse_drag)

- Status: **manual / dogfood scenarios for Phase 2b execution audit**
- Date: 2026-05-09
- Origin: `docs/llm-audit/phase2b-execution-audit.md` §3.3 carry-over
- Scope: mouse_click / mouse_drag の実機 GUI 依存シナリオ
- Parent audit section: 本 doc §3.x は `phase2b-execution-audit.md` §3.3 (mouse、cell 8-9) の carry-over scenario。各シナリオは parent table の cell 内 `dogfood-scenarios/mouse.md §3.x` 参照と相互リンク

---

## 3. mouse シナリオ

### 3.1 mouse_click — verifyDelivery 3 値 hint real-world transition

**目的**: `tests/unit/mouse-verify-classify.test.ts` の truth table が real button click で end-to-end に observed transition を生むことを確認。

**手順**:
- **delivered (focus 変化)**: Notepad 開いて、Edit menu → Find dialog 開く。Find dialog 内 textbox を `mouse_click(x,y, windowTitle:'Find')` → response `hints.verifyDelivery.status === 'delivered'` (focusedElement transition observed)
- **delivered (scrollPos 変化)**: Notepad で長文入力 → `mouse_click` で scrollbar drag → verticalScrollPos transition で delivered
- **focus_only (no observable change)**: Notepad 内空白部分を click → no focused element transition、no scroll → `verifyDelivery.status === 'focus_only'` + reason='no_observable_change'
- **unverifiable (Chromium overlay)**: Edge 内 overlay scroll 領域 (no Win32 scrollbar) を click → UIA read 不可 → `verifyDelivery.status === 'unverifiable'` + reason='read_back_unsupported'

**期待**: 4 transition 各々で hint shape が matrix §3.1 line 144 規範通り。
**Anti-pattern**: silent ok:true で hint 不在、または `delivered` 過剰判定で false-positive (#178 false-positive policy 違反)。

### 3.2 mouse_drag — Win11 foreground refusal (E3 dogfood SoT)

**目的**: `applyHoming` 共有 helper による foreground refusal が `mouse_drag` でも click suppress + ForegroundRestricted contract pin を保持することを実機確認。E3 (automated pin gap) の代替 SoT。

**手順**:
1. admin Notepad 起動 (`Start-Process notepad -Verb RunAs`)、文書に長文入力で scrollbar 出現
2. 通常ユーザー Claude session から `mouse_drag({startX:..., startY:..., endX:..., endY:..., windowTitle:'Administrator: Notepad', forceFocus:false})` 呼出
3. response 観測: `ok:false`、`code:"ForegroundRestricted"`、drag suppressed、Notepad 内 scrollbar 位置不変 + selection 不発生

**期待**: drag suppressed before SendInput sequence、誤 drag 防止。
**Anti-pattern**: ok:true で elevated 窓に drag landing → 誤 selection / drag-and-drop。

`mouse_click` 同型 contract pin (`tests/unit/issue-207-foreground-refusal-mouse.test.ts`) を `mouse_drag` でも適用、E3 で automated pin 化候補。

### 3.3 mouse_drag — drag bounds / mid-drag release / modifier-key state edge

**目的**: matrix §3.1 line 145「false-positive risk さらに高 (modifier-key state / mid-drag release / dragdrop API target 状態)」の degradation hint 表現を実機確認。

**手順**:
- **drag bounds (window 外)**: VS Code editor 内から outside の Explorer panel まで drag → 元 window 外で end → verifyDelivery で degradation 表現 (drag が consumed されたか不明)
- **mid-drag Esc**: drag 開始後 mid 経過で `keyboard:press(keys:'escape')` で abort → verifyDelivery: focus_only or unverifiable
- **modifier+drag**: Ctrl+drag (file copy) を Explorer で実行 → ctrl modifier 状態保持 + drag 完了 + verifyDelivery 表現

**期待**: 各 edge で hint で degradation 明示、ok:true で silent success していない。
**Anti-pattern**: silent ok:true で hint 不在、または false-positive `delivered` 表現。

### 3.4 mouse_drag — tab-drag heuristic + verifyDelivery chain

**目的**: matrix §3.1 line 145「tab-drag は別 heuristic (既存 `detectTabDragRisk`) が前段で gate 済」と本 drag 自身の verifyDelivery hint chain を実機確認。

**手順**:
1. Chrome browser tab を 3 つ開く
2. tab strip 上の tab に対して `mouse_drag({startX:(tab1 x), startY:(tab strip y), endX:(tab1 x + 200), endY:(tab strip y), windowTitle:'Chrome'})` 呼出
3. response 観測: `code:"TabDragBlocked"` (`detectTabDragRisk` で pre-gate)、または `ok:true` + verifyDelivery hint で drag 観測経路明示
4. tab order 変更が観測されること

**期待**: 危険な tab-drag は gate、許可された drag は hint で contract 保持。
**Anti-pattern**: tab detach / 別 window 化が誤発火 (#178 同型) → tab strip 設計者の意図しない window split。

---

## 共通操作上の note

- **homing**: `mouse_click` の `homing:true` (default) は target window 自動 foreground 化を実行 + UIA element under cursor 観測 chain。`homing:false` は pixel-level click のみ実行。`forceFocus` 引数と組合せで auto-escalate 制御。
- **speed: 0**: pure SendInput pixel injection (no mouse cursor visible movement)。CI / unit pin で利用、user audit では default speed 推奨。
- **verifyDelivery: false で performance**: 本軸が不要な場合は `verifyDelivery:false` で snapshot skip、ただし production observability から外れるので audit 中は `true` 推奨。
- **dragdrop API target**: real OLE drag-and-drop (Explorer / Excel) は production code level で hint emit、audit では `verifyDelivery: focus_only` 期待。
