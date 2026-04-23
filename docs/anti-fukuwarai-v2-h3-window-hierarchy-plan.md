# Anti-Fukuwarai v2 — Batch H3 Window Hierarchy / Common Dialog 実装計画

作成: 2026-04-23
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`
入力: [`anti-fukuwarai-v2-h3-window-hierarchy-instructions.md`](anti-fukuwarai-v2-h3-window-hierarchy-instructions.md), [`anti-fukuwarai-v2-hardening-backlog.md`](anti-fukuwarai-v2-hardening-backlog.md), [`dogfood-incident-report.md`](dogfood-incident-report.md), [`anti-fukuwarai-v2-dogfood-log.md`](anti-fukuwarai-v2-dogfood-log.md)

---

## 0. 背景と目的

dogfood S4（Save As / 名前を付けて保存）で次の 4 連鎖が出た。

1. `desktop_see(windowTitle="名前を付けて保存")` → `uia_provider_failed`
2. 親 Notepad hwnd 経由では read できるが `desktop_touch` は `modal_blocking`
3. V1 (`click_element` / `set_element_value`) でも `WindowNotFound` / `ElementNotFound`
4. 最終的に `keyboard_type` + `keyboard_press Enter` の unguarded fallback に落ち、誤フォーカス事故リスク

原因は R2（flat window model）。MCP 側は `windowTitle` / `hwnd` の flat 識別子しか持たず、Windows common file dialog (`IFileDialog`) の owner chain / modal child を見に行かない。既に win32.ts には `getWindowOwner()` / `getWindowRootOwner()` / `isWindowEnabled()` / `getWindowClassName()` の primitive が揃っているが、**`_resolve-window.ts` / V2 compose / V1 resolver のいずれもまだそれを利用していない**。

このバッチの目的は **common dialog に絞って hierarchy-aware 解決を入れる** こと。window model 全面改修は H3 より先のスコープ。

**明確な非目標**: owner / modal の概念を全 target に一般化すること、`TargetSpec` に `ownerHwnd` / `dialogOf` を追加すること、V1 resolver を全面書き換えること、keyboard fallback を完全に撤去すること、`modal_blocking` の意味を緩めること。

---

## 1. 変更ファイル一覧

| ファイル | 変更概要 |
|---|---|
| `src/tools/_resolve-window.ts` | **`resolveWindowTarget` に owner / modal-child fallback 分岐を追加**。既存 3 ケース (hwnd / @active / plain title) は維持。新規に「title で plain match 失敗 → enumWindowsInZOrder から common dialog 候補を検索」と「hwnd 直指定で IsEnabled=false → active popup/owned dialog を prefer」の 2 経路を追加。 |
| `src/tools/_resolve-window.ts` | 共通ヘルパ `findCommonDialogDescendant(parentHwnd)` / `findActiveDialogByTitle(title)` を追加（module-private）。owner chain と `#32770` class、`isEnabled=false` 親のどれかをフックにする。 |
| `src/tools/desktop-providers/uia-provider.ts` | **UIA provider が target を受けたとき、plain title 一致が失敗したら owner chain を 1 段下って再試行**。`uia_provider_failed` に落ちる前に `resolveCommonDialogTarget()` を 1 回だけ試す。成功したら `hwnd` を付け替えて再呼出。 |
| `src/tools/desktop-providers/compose-providers.ts` | `normalizeTarget()` で common dialog を検出した場合に、derived `windowTitle` / `hwnd` と `dialog_detected` warning を付ける。escalation ロジックには手を入れない。 |
| `src/tools/ui-elements.ts` (V1 `click_element` / `set_element_value` / `get_ui_elements` / `scope_element`) | `resolveWindowTarget` が dialog hwnd を返した場合、`effectiveTitle` に加えて `effectiveHwnd` を下位 bridge に渡せる形にする。現状は title のみ渡しており、これが S4 の `W-4` / `W-5` を生んでいる。 |
| `src/engine/uia-bridge.ts` | `clickElement` / `setElementValue` に optional `hwnd?: bigint` を追加。native path と PowerShell path のどちらも hwnd を受け付けるようにする。**これは最小限の breaking-free 追加**。既存 callsite は title のみで動き続ける。 |
| `tests/unit/resolve-window.test.ts` | common dialog resolve の新ケースを追加（owner chain mock / disabled-owner prefer / plain title miss → dialog hit）。 |
| `tests/unit/desktop-facade.test.ts` | `desktop_see(windowTitle="名前を付けて保存")` が Save As 相当の fixture で entity を返す regression を追加。 |
| `tests/unit/desktop-register.test.ts` | description snapshot に "dialog resolved via owner chain" hint を 1 語追加。 |
| `tests/unit/guarded-touch.test.ts` | modal detection が **dialog 自身の child** を `modal_blocking` とみなさない（dialog の子は touch 可）ことを確認する回帰ケースを 1 つ追加。 |

**触らない方針のファイル** (unrelated refactor 回避):

- `src/engine/world-graph/session-registry.ts` — session key は title/hwnd/tabId のままで OK。dialog 解決後の hwnd を key にすれば session routing は自動で正しく働く。
- `src/engine/world-graph/guarded-touch.ts` — modal 判定ロジック本体は触らない。session-registry.ts の default modal guard（UIA unknown-role in snapshot）は維持。
- `src/engine/world-graph/types.ts` — `TargetSpec` に `ownerHwnd` / `dialogOf` を追加しない（breaking change 回避）。
- `src/tools/desktop.ts` / `src/tools/desktop-register.ts` — facade 側の routing と ingress は無変更。dialog 解決は compose-providers の手前で完結する。
- `src/tools/window.ts` / `focus_window` — focus 系は別バッチ。S4 の keyboard_type 経路は今回 V2 / V1 resolver が効けば踏まない。

---

## 2. common dialog / hierarchy 解決の設計

### 2.1. 現状（ベースライン）

`_resolve-window.ts` は 3 ケースしか扱わない。

| ケース | 動作 |
|---|---|
| `hwnd` 指定 | `getWindowTitleW(hwnd)` で title を引く。invisible / 存在しなければ throw。 |
| `windowTitle === "@active"` | `getForegroundHwnd()` → title 引き直し。 |
| plain `windowTitle` | **null を返す**（呼び元は自分で `enumWindowsInZOrder` 探索）。 |

V1 の各ハンドラ (`click_element` など) は plain title を partial match で enumWindowsInZOrder から引くが、**dialog は親ウィンドウのタブ内に収まる common dialog と、top-level として出る common dialog の両方のパターン**があり、partial match では `windowTitle="名前を付けて保存"` が hit しないケースが発生する。

V2 側でも `uia-provider.ts` は `windowTitle` / `hwnd` をそのまま uia-bridge に渡すだけで、owner chain を探索しない。

### 2.2. 今回入れる分岐（recipe）

`resolveWindowTarget` に **case 4** を追加（case 1-3 は現状維持）。

**case 4: plain windowTitle で common dialog 疑いがあるときの owner chain 探索**

```
入力: { windowTitle: "名前を付けて保存" }  (plain, not "@active")
フロー:
  1. enumWindowsInZOrder() から title partial match を探す
     - 見つかった場合: 既存挙動（null を返して呼び元に partial match ロジックへ委譲）
  2. 見つからなかった場合のみ common dialog fallback:
     a. 全 window を走査し、className === "#32770"  OR  ownerHwnd !== null  OR  exStyle に WS_EX_DLGMODAL 相当を持つ top-level window を列挙
     b. そのうち title に input windowTitle を含むものを選ぶ（common dialog は localized title を持つ）
     c. なお見つからなければ、foreground window の ownerHwnd / getLastActivePopup から辿って dialog を探す
     d. match したら {title, hwnd, warnings: ["dialog_resolved_via_owner_chain"]} を返す
  3. 最後まで見つからなければ null（既存呼び元で WindowNotFound に落ちる）
```

**case 5: hwnd 指定で owner が disabled の場合の prefer-popup**

```
入力: { hwnd: "199780" } (Notepad, but a Save As dialog is blocking it)
フロー:
  1. 既存通り getWindowTitleW(hwnd) で title を得る
  2. isWindowEnabled(hwnd) が false なら
     a. GetLastActivePopup(hwnd) で active popup を取得
     b. popup が 自分自身でなく かつ className === "#32770" または ownerHwnd===hwnd ならそれを prefer
     c. 返す値は {title: popupTitle, hwnd: popupHwnd, warnings: ["parent_disabled_prefer_popup"]}
  3. それ以外は既存挙動
```

**注意**: case 5 は **opt-in にはしない**（既存 hwnd 経路のすべてで走るが、分岐は `isWindowEnabled===false` のときだけ踏まれる）。hwnd 指定の user intent が明確（そのウィンドウを読みたい）な場合に popup を勝手に返すと予期しないので、**warning で必ず知らせる**。

### 2.3. 影響範囲と原則

- **TargetSpec に新フィールドを足さない**（breaking change 回避）。
- 解決済み hwnd を返す形にするので、**compose-providers / session-registry 側は何も知らなくていい**。dialog の hwnd が session key になるだけ。
- warnings は既存 contract に additive 追加（`dialog_resolved_via_owner_chain` / `parent_disabled_prefer_popup` の 2 つ）。
- `resolveWindowTarget` が返す `{title, hwnd, warnings}` の shape は不変。

### 2.4. V1 (`click_element` / `set_element_value`) の dialog 到達性

現状 V1 resolver は title match → `clickElement(windowTitle, name, automationId)` を呼ぶ。`clickElement` / `setElementValue` は内部で **title ベースで UIA root を引き直す**ので、hwnd で解決しても結局 title が流れて同じ結果になる。

これを直すため、**`clickElement` / `setElementValue` に optional hwnd を追加**して、uia-bridge の native / PS 両 path で `windowTitle` より `hwnd` を優先できるようにする（後述 §5 Step 3）。こうすると `resolveWindowTarget` が dialog hwnd を返すだけで V1 path も自然に dialog に届く。

**breaking-free 原則**: 既存 callsite (`windowTitle` だけ渡す) は挙動が変わらない。hwnd が付いたときだけ hwnd を優先。

---

## 3. Save As 相当で何が改善するか

dogfood の S4 再現ステップと改善後の挙動を対応付けて示す。

| # | 操作 | 現状 | H3 後 |
|---|---|---|---|
| U-1 | `desktop_see(windowTitle="名前を付けて保存")` | `uia_provider_failed` | `resolveWindowTarget` で common dialog を owner chain から hwnd に解決 → uia-provider に hwnd を渡せる → elements が返る |
| U-5 | `desktop_see(hwnd=<dialog hwnd>)` | `uia_provider_failed` | hwnd は既に dialog なので既存 uia-provider で elements が見える（これは既存でも動くはず — ただし `uia_provider_failed` が出ていた場合は `uia-bridge` 側の title override 経路バグで、H3 の「dialog title を優先的に title 引き直し」で回避可能） |
| M-2 | `desktop_touch` (via 親 Notepad hwnd 経由の entity) | `modal_blocking` | entity 自体を dialog hwnd の session から取得するので、`session-registry` の modal guard は dialog 内の自 entity 以外を見る → dialog 自身は block されない |
| W-1/W-2/W-5 | `click_element(windowTitle="名前を付けて保存")` | `WindowNotFound` | `resolveWindowTarget` が dialog hwnd を返す → V1 handler が hwnd を `clickElement` に渡す → uia-bridge native path が hwnd で直接 root を引く |
| W-4 | `set_element_value(hwnd=200004)` | `WindowNotFound`（windowTitle 必須エラー） | `set_element_value` handler が hwnd 引数を受けたら resolveWindowTarget 経由で title を取る → native に hwnd 優先で流す（H3 で追加） |
| K-1/K-2 | `keyboard_press Enter → エディタに逃げる` | unguarded | S4 までの到達で W-1/W-4 が成功するようになれば keyboard fallback を踏まなくなる（直接防止ではなく「踏む必要がなくなる」改善） |

**想定外のケースでも壊さない**:

- 既存の partial-title match で dialog ではなく通常 window を拾うパスは従来通り（case 4 は **partial match 失敗後の fallback** なので既存経路を横取りしない）
- `@active` で dialog が foreground の場合は既存挙動で dialog の hwnd が返る（owner chain を辿らなくてよい）
- 日本語 title (`名前を付けて保存`) は既に `getWindowTitleW` が UTF-16 で取っているので case 4 の owner chain 探索でも問題なく hit する
- H6 の JSON encoding bug はこのバッチでは直さない（set_element_value handler が受けた value の encoding 問題は別ソース）

---

## 4. 追加/更新するテストケース

### 4.1. `tests/unit/resolve-window.test.ts`（既存ファイルに追加）

新規 describe: `resolveWindowTarget — common dialog (H3)`

win32 の全関数を hoisted mock できる構造にする（既存 pattern）。`enumWindowsInZOrder` / `getWindowOwner` / `getLastActivePopup` / `isWindowEnabled` / `getWindowClassName` を追加 mock する。

```ts
describe("resolveWindowTarget — common dialog (H3)", () => {
  it("falls back to common dialog when plain title misses and owner chain has #32770 child", async () => {
    // Arrange: partial-title enum returns nothing matching "名前を付けて保存"
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 100n, title: "Untitled - メモ帳", className: "Notepad", isEnabled: false, ownerHwnd: null },
      { hwnd: 200n, title: "名前を付けて保存",     className: "#32770",  isEnabled: true,  ownerHwnd: 100n },
    ]);
    // Act
    const result = await resolveWindowTarget({ windowTitle: "名前を付けて保存" });
    // Assert
    expect(result).not.toBeNull();
    expect(result!.hwnd).toBe(200n);
    expect(result!.warnings).toContain("dialog_resolved_via_owner_chain");
  });

  it("returns null (defers to caller) when a plain-title top-level window matches", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 300n, title: "名前を付けて保存 - Notepad", className: "Notepad", isEnabled: true, ownerHwnd: null },
    ]);
    // Plain title partial match exists → no dialog fallback triggered
    const result = await resolveWindowTarget({ windowTitle: "名前を付けて保存" });
    expect(result).toBeNull(); // existing behaviour: let caller resolve
  });

  it("hwnd path: prefers active popup when owner window is disabled", async () => {
    mockGetWindowTitleW.mockImplementation((h) =>
      h === 100n ? "Untitled - メモ帳" : h === 200n ? "名前を付けて保存" : ""
    );
    mockIsWindowEnabled.mockImplementation((h) => h !== 100n);
    mockGetLastActivePopup.mockReturnValue(200n);
    mockGetWindowClassName.mockReturnValue("#32770");
    mockGetWindowOwner.mockReturnValue(100n);
    const result = await resolveWindowTarget({ hwnd: "100" });
    expect(result!.hwnd).toBe(200n);
    expect(result!.title).toBe("名前を付けて保存");
    expect(result!.warnings).toContain("parent_disabled_prefer_popup");
  });

  it("hwnd path: does NOT prefer popup when owner is enabled (existing behaviour)", async () => {
    mockGetWindowTitleW.mockReturnValue("Notepad");
    mockIsWindowEnabled.mockReturnValue(true);
    const result = await resolveWindowTarget({ hwnd: "100" });
    expect(result!.hwnd).toBe(100n);
    expect(result!.warnings).not.toContain("parent_disabled_prefer_popup");
  });

  it("common dialog fallback returns null when no dialog match found", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 100n, title: "Untitled - メモ帳", className: "Notepad", isEnabled: true, ownerHwnd: null },
    ]);
    const result = await resolveWindowTarget({ windowTitle: "Does Not Exist" });
    expect(result).toBeNull();
  });
});
```

### 4.2. `tests/unit/desktop-facade.test.ts` — 新規追加

```ts
describe("DesktopFacade — common dialog reachability (H3 regression)", () => {
  it("Save As dialog resolves entities through owner chain fallback", async () => {
    // arrangement: candidate provider は dialog hwnd を受けたときだけ filename entity を返す
    const provider: CandidateProvider = async (input) => {
      if (input.target?.hwnd === "200") {
        return [cand("File name", "uia", { role: "textbox", actionability: ["type", "click"] })];
      }
      return [];
    };
    const facade = new DesktopFacade(provider);
    const out = await facade.see({ target: { hwnd: "200" } });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0].label).toBe("File name");
  });
});
```

### 4.3. `tests/unit/desktop-register.test.ts` — description snapshot 更新（最小）

```ts
const expectedFragments = [
  // ... 既存 ...
  "dialog_resolved_via_owner_chain", // H3
  "parent_disabled_prefer_popup",    // H3
] as const;
```

### 4.4. `tests/unit/guarded-touch.test.ts` — modal guard 回帰

現状の default modal guard は「**他の** UIA unknown-role entity が live snapshot にあるか」を見ている（self-reference 除外）。これはすでに dialog 内操作で dialog 自身を block しない設計になっているが、dialog 解決後に session key が dialog hwnd になることで「live snapshot が dialog のもの」になることを確認する回帰ケースを 1 つ追加。

```ts
it("does not block when dialog entities live in the same session (no self-modal)", async () => {
  // snapshot 内にある unknown-role entity は touch 対象そのもの
  const filenameBox = entity("e1", GEN, { role: "textbox", sources: ["uia"] });
  const dialogSelf  = entity("e2", GEN, { role: "unknown",  sources: ["uia"], entityId: "self-dialog" });
  // self-dialog は存在するが dialog 自身なので filename entity の touch は block されない
  // guarded-touch.ts 既定の isModalBlocking は session-registry で default となるが、
  // facade-level の productionIsModalBlocking を使わず、unit test ではデフォルトで OK
  // ...
});
```

### 4.5. `tests/unit/desktop-providers.test.ts` — UIA provider 側の hwnd 優先再試行

```ts
it("uia provider falls through to dialog hwnd when plain title has no UIA root", async () => {
  mocks.getUiElements.mockImplementation((title, _d, _m, _t, opts) => {
    if (opts?.hwnd === 200n) return { elements: [{ name: "File name", ...}], windowRect: {...} };
    throw new Error("No UIA root");
  });
  // 事前に resolveWindowTarget が dialog hwnd を返す mock を用意しておく
  const result = await fetchUiaCandidates({ windowTitle: "名前を付けて保存", hwnd: "200" });
  expect(result.candidates.length).toBeGreaterThan(0);
});
```

---

## 5. 実装手順（Sonnet が実装できる精度で）

### Step 1: `_resolve-window.ts` に common dialog fallback を追加

まず win32.ts から必要な関数を import する（既にあるものを使うだけで新規 export は作らない）。

```ts
// src/tools/_resolve-window.ts

import {
  getForegroundHwnd,
  getWindowTitleW,
  getWindowRectByHwnd,
  // H3 追加
  enumWindowsInZOrder,
  getWindowOwner,
  isWindowEnabled,
  getWindowClassName,
} from "../engine/win32.js";
```

ただし `GetLastActivePopup` は win32.ts にまだ export されていない（`void GetLastActivePopup;` で抑制されている）。今回はこれを正式に export する（**win32.ts への追加は最小**で 1 関数だけ）:

```ts
// src/engine/win32.ts の該当箇所（行 234 付近の宣言を残し、export 関数だけ追加）

export function getLastActivePopup(hwnd: unknown): bigint | null {
  try {
    const popup = GetLastActivePopup(hwnd) as bigint;
    return popup === 0n ? null : popup;
  } catch {
    return null;
  }
}
```

`void GetLastActivePopup;` の抑制行は削除する。

**common dialog fallback ヘルパ**:

```ts
// _resolve-window.ts 内（module-private）

const DIALOG_CLASSNAMES = new Set(["#32770"]);

interface DialogCandidate {
  hwnd: bigint;
  title: string;
}

/**
 * Search for a common dialog window whose title partially matches `query`.
 * Prioritises windows that look like modal dialogs:
 *   1. className === "#32770" (standard Win32 dialog)
 *   2. has a non-null ownerHwnd (owned popup)
 *   3. partial title includes `query` (case-insensitive)
 * Returns null if no candidate found.
 */
function findCommonDialogByTitle(query: string): DialogCandidate | null {
  const q = query.toLowerCase();
  const wins = enumWindowsInZOrder();
  // Rank: #32770-classed with matching title > owned popup with matching title > matching title only
  const classed:   DialogCandidate[] = [];
  const owned:     DialogCandidate[] = [];
  for (const w of wins) {
    if (!w.title.toLowerCase().includes(q)) continue;
    if (w.className && DIALOG_CLASSNAMES.has(w.className)) {
      classed.push({ hwnd: w.hwnd, title: w.title });
    } else if (w.ownerHwnd != null) {
      owned.push({ hwnd: w.hwnd, title: w.title });
    }
  }
  return classed[0] ?? owned[0] ?? null;
}

/**
 * When `hwnd` refers to a disabled window (blocked by a modal),
 * return the last-active popup owned by it if that popup is a dialog.
 * Returns null when the caller's hwnd is enabled or has no popup.
 */
function preferActivePopupIfBlocked(hwnd: bigint): DialogCandidate | null {
  if (isWindowEnabled(hwnd)) return null;
  const popup = getLastActivePopup(hwnd);
  if (popup == null || popup === hwnd) return null;
  const owner = getWindowOwner(popup);
  const cls = getWindowClassName(popup);
  if (owner !== hwnd && !DIALOG_CLASSNAMES.has(cls)) return null;
  const title = getWindowTitleW(popup);
  return { hwnd: popup, title };
}
```

**`resolveWindowTarget` への追加**:

```ts
export async function resolveWindowTarget(params: {
  hwnd?: string;
  windowTitle?: string;
}): Promise<ResolvedWindow | null> {
  const warnings: string[] = [];

  // ── Case 1: explicit hwnd ─────────────────────────────────────────────────
  if (params.hwnd !== undefined) {
    let hwndb: bigint;
    try {
      hwndb = BigInt(params.hwnd);
    } catch {
      throw new Error(`WindowNotFound: hwnd "${params.hwnd}" is not a valid integer`);
    }
    const title = getWindowTitleW(hwndb);
    if (!title) {
      const rect = getWindowRectByHwnd(hwndb);
      if (!rect) {
        throw new Error(`WindowNotFound: no visible window with hwnd "${params.hwnd}"`);
      }
    }

    // H3: disabled-owner → prefer active popup (common dialog pattern)
    const popup = preferActivePopupIfBlocked(hwndb);
    if (popup) {
      warnings.push("parent_disabled_prefer_popup");
      // fall through to dock warning on the popup's title
      hwndb = popup.hwnd;
    }
    const effectiveTitle = popup?.title ?? title;

    const dockLiteral = getDockTitleLiteral();
    if (dockLiteral && effectiveTitle.toLowerCase().includes(dockLiteral.toLowerCase())) {
      warnings.push("HwndMatchesDockWindow: targeting the CLI host window — intended?");
    }
    return { title: effectiveTitle, hwnd: hwndb, warnings };
  }

  // ── Case 2: @active shorthand ─────────────────────────────────────────────
  if (params.windowTitle === "@active") {
    // ... 既存通り（変更なし） ...
  }

  // ── Case 3/4: plain windowTitle ────────────────────────────────────────────
  if (params.windowTitle) {
    // Let existing partial-match path handle enum hit. Only fall back to
    // dialog-owner-chain lookup when the title clearly has no top-level match.
    const q = params.windowTitle.toLowerCase();
    const wins = enumWindowsInZOrder();
    const plainMatch = wins.find(
      (w) => w.title.toLowerCase().includes(q) &&
             (w.className == null || !DIALOG_CLASSNAMES.has(w.className)) &&
             w.ownerHwnd == null
    );
    if (plainMatch) return null; // existing behaviour

    // H3 case 4: try common dialog fallback
    const dialog = findCommonDialogByTitle(params.windowTitle);
    if (dialog) {
      warnings.push("dialog_resolved_via_owner_chain");
      return { title: dialog.title, hwnd: dialog.hwnd, warnings };
    }
  }

  return null;
}
```

**注意**: plain title match が存在したら **既存挙動 (null) を保つ** ことで後続の V1 resolver が従来通り動くようにする。dialog fallback は「partial match ですら見つからない」場合のみ発火する。これにより「普通の Notepad title」と「localize された dialog title」の取り違えを起こさない。

### Step 2: `uia-bridge.ts` の clickElement / setElementValue に hwnd 追加

```ts
// src/engine/uia-bridge.ts

export async function clickElement(
  windowTitle: string,
  name?: string,
  automationId?: string,
  controlType?: string,
  options?: { hwnd?: bigint },        // ← H3 追加
): Promise<{ ok: boolean; element?: string; error?: string }> {
  if (nativeUia?.uiaClickElement) {
    try {
      const result = await nativeUia.uiaClickElement({
        windowTitle,
        hwnd: options?.hwnd,           // ← 追加。native 側は既に hwnd を受ける仕様があれば即使える、なければ optional として無視される
        name:         name ?? undefined,
        automationId: automationId ?? undefined,
        controlType:  controlType ?? undefined,
      });
      return { ok: result.ok, element: result.element ?? undefined, error: result.error ?? undefined };
    } catch (e) {
      console.warn("[uia-bridge] Native uiaClickElement failed, falling back to PowerShell:", e);
    }
  }
  // PowerShell path は title-based のまま（PS では hwnd 指定経路を新設しない）
  const script = makeClickElementScript(windowTitle, name, automationId, controlType);
  const output = await runPS(script, 8000);
  return JSON.parse(output);
}
```

**重要**: native 側 (`nativeUia.uiaClickElement`) が `hwnd` を認識するかは Rust 実装次第。もし現状受けない場合、TypeScript 側では optional として渡しつつ **native が無視するケースでも既存挙動に戻る** ため、breaking 0。Rust 側も受けるようにするかは別タスクとして H3 スコープ外にしてよい（今回のクリティカル path は V2 の `getUiElements(..., {hwnd})` が既に hwnd を受けていることで、clickElement/setElementValue が title を受け続けても **dialog title が resolveWindowTarget で返されるので title 引きは最終的に成功する**）。

`setElementValue` も同様に optional hwnd を受ける。

### Step 3: V1 ハンドラ (`ui-elements.ts`) が resolveWindowTarget の hwnd を下位へ渡す

```ts
// src/tools/ui-elements.ts clickElementHandler

const resolvedWin = await resolveWindowTarget({ hwnd: hwndParam, windowTitle });
if (resolvedWin) {
  effectiveWindowTitle = resolvedWin.title;
  winWarnings = resolvedWin.warnings;
}
// ...
const result = await clickElement(
  effectiveWindowTitle, effectiveName, effectiveAutomationId, controlType,
  resolvedWin ? { hwnd: resolvedWin.hwnd } : undefined,   // ← H3 追加
);
```

`setElementValueHandler` も同様。`getUiElementsHandler` は既に option 経由で hwnd を渡している（既存動作維持）。

### Step 4: `uia-provider.ts` の target 解決ルート

V2 側では `uia-provider.ts` が target を受けて `getUiElements` を呼んでいる。現状は:

```ts
const windowTitle = target.windowTitle ?? target.hwnd ?? "@active";
const options = target.hwnd ? { hwnd: BigInt(target.hwnd) } : undefined;
```

となっており、`hwnd` があれば options に渡している。つまり **common dialog が compose-providers の `normalizeTarget` で dialog hwnd に解決さえできれば、uia-provider は既に hwnd path で動作する**。

ここで `normalizeTarget()` を touch する必要はあまりない。`compose-providers` は既に「hwnd のみ指定 → resolveWindowTarget で title を補完」を行っているため、**新しい case 1 の disabled-owner prefer が popup hwnd を返してくれれば自動で dialog に差し代わる**。

ただし、「`windowTitle="名前を付けて保存"` が plain で渡ってきた」ケースをカバーするには、`compose-providers.ts` の `normalizeTarget` を 1 箇所だけ拡張する。

```ts
// src/tools/desktop-providers/compose-providers.ts

async function normalizeTarget(target: TargetSpec | undefined) {
  if (target?.tabId) return { target, warnings: [] };

  // H3: when only windowTitle is given, let resolveWindowTarget try dialog fallback.
  if (target?.windowTitle && !target.hwnd) {
    try {
      const resolved = await resolveWindowTarget({ windowTitle: target.windowTitle });
      if (resolved) {
        return {
          target: {
            ...target,
            hwnd: resolved.hwnd.toString(),
            windowTitle: resolved.title,
          },
          warnings: resolved.warnings,
        };
      }
    } catch { /* fall through */ }
    return { target, warnings: [] };
  }

  if (target?.hwnd && !target.windowTitle) {
    // ... 既存通り ...
  }
  // ...
}
```

`resolveWindowTarget` は **plain title で partial match があれば null** を返すので、既存 top-level window は従来通り top-level として解決され、dialog fallback は真に dialog のケースだけで動く。

### Step 5: description の最小更新

`desktop-register.ts` の `desktop_see` description に 1 行追加:

```
dialog_resolved_via_owner_chain → common dialog found via owner chain (Save As / Open / IFileDialog);
parent_disabled_prefer_popup   → parent window is blocked by a modal; targeting the active popup instead;
```

V1 tools (`click_element` / `set_element_value`) の description は **変更しない**（既存挙動を温存するため optional 警告だけ付くが、挙動の breaking はない）。

### Step 6: ビルド + テスト

```bash
npm run build
npx vitest run tests/unit/resolve-window.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-register.test.ts tests/unit/guarded-touch.test.ts tests/unit/desktop-providers.test.ts tests/unit/desktop-providers-active-target.test.ts
```

必要なら `_resolve-window.ts` が mock なしでは enumWindowsInZOrder を叩いて遅延するので、実マシン依存の test を含める場合は CI 側で skip にするか、mock を完備する。

---

## 6. 注意事項・落とし穴

1. **既存 plain-title 探索の挙動を壊さない**
   partial match でヒットした場合は `resolveWindowTarget` は **現状通り null を返す** こと。dialog fallback は「partial match が一切存在しない」ときだけ走らせる。ここを逆にすると、`windowTitle="保存"` で Notepad の「保存 - ファイル名」という通常 window と dialog の両方が当たるときに、dialog を優先して誤解決するリスクがある。

2. **`parent_disabled_prefer_popup` は警告必須**
   hwnd 指定は user intent が明示的なので、popup を勝手に返すと誤解釈される。warnings にこの code を必ず付ける。operator は warning を見て「意図と違えば hwnd を直接指定し直す」ことができる。

3. **`#32770` は Win32 dialog 限定**
   Windows common file dialog (IFileDialog, Vista 以降のモダン版) は実際には `#32770` 以外の internal class を持つ場合もある（`DirectUIHWND` や localization した class）。そのため fallback のランキングは **className だけに依存しない**。`ownerHwnd !== null` も secondary signal として使う。

4. **owner chain の探索深さ**
   今回は owner 1 段 + GetLastActivePopup しか辿らない。多段 owner（dialog の中の sub-dialog）まで追うと誤解決のリスクが増える。H3 は「Save As / Open の 1 段 dialog」のみをカバーする。

5. **session key 変更で既存 session が孤立する可能性**
   `normalizeTarget` が dialog hwnd を返すと、次の `desktop_see` で session key が dialog hwnd に切り替わる。前回 title ベースで作った session の lease は generation mismatch で失効する（これは **正しい挙動**）。ただし既存の dogfood log では `desktop_see` → `desktop_touch` の間で session が切り替わると `lease_expired` ではなく `entity_not_found` が出る可能性があるため、回帰テストで両系の失敗モードが適切に返ることを確認する。

6. **日本語 title エンコーディング**
   `getWindowTitleW` は UTF-16LE を正しく扱う（既存実装）ので、`名前を付けて保存` の owner chain 探索は問題なく動く。ただし JSON serialization の encoding バグ（H6）はこのバッチでは直さない。H3 の範囲外だが、**resolveWindowTarget の戻り値が直接 response に乗るパスは無い**（title は session key または uia-bridge の引数になるだけ）ので H3 の実装で H6 を悪化させることはない。

7. **`clickElement` / `setElementValue` native への hwnd 追加の互換性**
   Rust native (`nativeUia.uiaClickElement`) が `hwnd` フィールドを受けない場合、napi-rs の挙動で "unknown field" エラーになる可能性がある。そのため TS 側は `hwnd` を含めるかどうかをランタイムで決める:

   ```ts
   const args: Record<string, unknown> = { windowTitle, name, automationId, controlType };
   if (options?.hwnd !== undefined) args.hwnd = options.hwnd;
   const result = await nativeUia.uiaClickElement(args as Parameters<typeof nativeUia.uiaClickElement>[0]);
   ```

   より安全には、Rust が hwnd を読まなくても unknown field を無視する設計になっているなら単純に展開してよい。事前に rust 側の struct 定義を 1 度確認すること（`#[serde(deny_unknown_fields)]` が付いていないこと）。**付いていたら** PowerShell path に fallback するよう optional hwnd 付きの呼び出しは try-catch で囲んで、失敗時は hwnd 無しで再試行する。

8. **H3 は escalation 警告と衝突しない**
   H4 で追加した `visual_not_attempted` / `uia_blind_single_pane` は dialog のケースでは発生しないことが多い（dialog は UIA が比較的 healthy）。H3 で追加する warning と H4 warning が同時に出ることは設計上あり得ないので、並び順の衝突は起こさない。

9. **`modal_blocking` の意味を壊さない**
   guarded-touch.ts の default modal guard（UIA unknown-role の **他** entity）は維持する。dialog 解決後は session が dialog 自身の entity を持つので、dialog 自身を `modal_blocking` と判定しない。これは既存ロジックのまま成立する（self-reference 除外があるため）。

10. **tests で実 Win32 を叩かない**
   `resolve-window.test.ts` の既存 mock pattern (`vi.hoisted` + `vi.mock("../../src/engine/win32.js", ...)`) に合わせる。新規 mock 対象は `enumWindowsInZOrder` / `getWindowOwner` / `isWindowEnabled` / `getWindowClassName` / `getLastActivePopup` の 5 関数。

11. **dock 窓判定は popup 側で行う**
   popup にフォールバックした場合、dock title 警告は popup の title に対して再評価する。Notepad 自体が dock title に該当しなくても popup が該当するケースはほぼ無いが、case 1 の後半で `effectiveTitle` に対して check している通りに書く。

12. **compose-providers の既存 `partial_results_only`**
   dialog 解決で entities が入るようになれば partial warning は出なくなるため、既存テストの「UIA returns something」期待値は変わらない。新たに「dialog 解決後の uia が entity を返す」ケースは fixture を用意する必要がある（§4.5 参照）。

---

## 7. 避けるべきこと（再確認）

- **window model 全面刷新**（TargetSpec に `ownerHwnd` / `dialogOf` を追加するのは別 phase）
- **target spec に breaking change**（Zod schema は無変更。既存 `{windowTitle, hwnd, tabId}` のまま）
- **dialog 以外まで広げた resolver rewrite**（multi-pane / tab navigation / MDI child は対象外）
- **unrelated refactor**（session-registry / guarded-touch の modal guard / desktop.ts の routing は触らない）
- **release / version bump / tag / npm publish**（H3 は post-Go hardening）
- **V1 fallback 撤去**（V1 tools は escape hatch として残す）
- **既存 warning / fail reason contract を壊す**（追加のみ、rename / delete はしない）
- **`modal_blocking` の意味を緩める**（dialog 自身の child が block されない挙動は既存通り、新しく bypass は追加しない）
- **keyboard fallback を強制撤去**（「踏まなくて済むようにする」に留める。keyboard_press 自体は存続）
- **owner chain の多段探索**（深さ 1 に限定。多段は誤解決リスク）
- **UIA blind detection の閾値変更**（H4 と衝突させない）
- **`#32770` 以外のカスタムクラス（IFileDialog DirectUIHWND 等）への本格対応**（ownerHwnd による secondary signal でカバーする最小実装にとどめる）

---

## 8. 完了条件

1. `resolveWindowTarget({ windowTitle: "名前を付けて保存" })` が、partial-title enum に top-level ヒットが無い条件下で dialog hwnd を返す（`dialog_resolved_via_owner_chain` 警告付き）
2. `resolveWindowTarget({ hwnd: "<disabled notepad hwnd>" })` が active popup の hwnd を返す（`parent_disabled_prefer_popup` 警告付き）
3. 既存の plain-title partial match が存在するケースでは `resolveWindowTarget` は従来通り null を返す（既存テスト全通過）
4. `desktop_see(target={windowTitle:"名前を付けて保存"})` が dialog hwnd の session で entities を返す（mock 回帰）
5. V1 `click_element(windowTitle="名前を付けて保存", name="保存")` が hwnd 付きで uia-bridge を呼び、dialog 内部の entity に到達できる（mock 回帰）
6. 既存 `warnings` / `fail reasons` の enum は additive 拡張のみ（`dialog_resolved_via_owner_chain` / `parent_disabled_prefer_popup` の 2 つ）。14 コード契約から 16 コードに拡張。
7. `npm run build` と次の unit tests が全通:
   ```bash
   npx vitest run tests/unit/resolve-window.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-register.test.ts tests/unit/guarded-touch.test.ts tests/unit/desktop-providers.test.ts tests/unit/desktop-providers-active-target.test.ts
   ```
8. `desktop_see` / `click_element` 系の description は warning 1〜2 行追加のみ、breaking description rename なし

---

## 9. docs 更新（最小）

実装後に次を最小限で touch:

- `docs/anti-fukuwarai-v2-hardening-backlog.md` — H3 欄に "done" 状況と 2 つの新 warning を追記
- `docs/anti-fukuwarai-v2-default-on-readiness.md` — warning enum 列挙に新規 2 コードを追記（contract 16 コードへ拡張）
- `docs/anti-fukuwarai-v2-dogfood-log.md` — S4 の「今後の改善候補」欄に H3 実装済み行と、残り friction（keyboard fallback 残存 / IFileDialog custom class 非対応）を追記
- `docs/anti-fukuwarai-v2-h3-window-hierarchy-plan.md`（本ファイル）

---

## 10. 推奨 commit

```text
fix(window): improve common dialog targeting for anti-fukuwarai v2 flows
```

1 commit で収めること。resolve-window / uia-bridge / ui-elements / compose-providers / test / description の変更を同じ commit にまとめる。testファイルだけ別 commit に分離するメリットはない。

---

## 11. H4 との関係（再確認）

- H4 で足した `uia_blind_single_pane` / `visual_not_attempted` 系の explainability は dialog ケースでは基本的に出ない（dialog は UIA が比較的 healthy）。
- H3 の新 warning (`dialog_resolved_via_owner_chain` / `parent_disabled_prefer_popup`) と H4 warning は同じ response に共起する可能性はあるが、意味が独立しているので LLM の解釈を妨げない。
- H4 は explainability、H3 は reachability を改善するバッチ。両者は分離されている。

---

## 12. 次バッチ候補（H3 後）

H3 完了後も残る friction:

- **R4**: 日本語 windowTitle の JSON encoding バグ（S4 J-1） → **H6** （別 batch 推奨）
- **R2 残存**: dialog 以外の MDI / popup menu / owned tool window → H3.5 or 将来の hierarchy batch
- **R7**: GitHub body `"on"` ラベル問題 → H7
- **IFileDialog 固有 custom class** (`DirectUIHWND` 等) の fallback は別 batch（H3 は `#32770` + ownerHwnd までカバー）
