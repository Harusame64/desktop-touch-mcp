# Plan: #22 `browser_launch` に `killExisting` オプション追加

- **Issue**: https://github.com/Harusame64/desktop-touch-mcp/issues/22
- **Label**: enhancement, v1.1
- **想定スコープ**: 1 PR、1 セッションで完結
- **作成日**: 2026-04-28

---

## 背景

ユーザーが普段使いの Chrome / Edge / Brave を `--remote-debugging-port` なしで起動済の場合、`browser_launch` は以下の挙動になる:

1. `listTabs(port)` が ECONNREFUSED → spawn パスへフォールバック
2. spawn しても同じ `--user-data-dir` を共有するプロファイルがロックされ、新プロセスは既存ブラウザに引き継がれる (Chromium の SingleInstance 動作)
3. CDP ポートは開かないまま `pollUntil` がタイムアウト

→ ユーザーが手動で `Stop-Process -Name chrome -Force` してから再実行する必要がある = MCP だけで完結しない。

---

## 解決策

`browserLaunchSchema` に `killExisting: boolean` (default false) を追加。true のとき、spawn の前に対象 exe を taskkill する。

### スコープ外（明示）

- 既存ブラウザのタブ復元 / セッション保持: NO（kill 時の未保存タブ消失はユーザー責任、ツール説明で警告）
- 確認プロンプト: NO（MCP に対話 UI なし、`killExisting:true` を明示要求した時点で同意とみなす）
- 他プラットフォーム対応: NO（Windows 専用 MCP）

---

## 設計

### 1. Schema 拡張 (`src/tools/browser.ts:188-215`)

```ts
export const browserLaunchSchema = {
  browser: z.enum(["auto", "chrome", "edge", "brave"]).default("auto").describe(...),
  port: portParam,
  userDataDir: z.string().default("C:\\tmp\\cdp").describe(...),
  url: z.string().optional().describe(...),
  waitMs: z.coerce.number().int().min(1000).max(30_000).default(10_000).describe(...),
  // 追加 ↓
  killExisting: coercedBoolean().default(false).describe(
    "When true, terminate existing chrome.exe / msedge.exe / brave.exe processes before launch. " +
    "Use this when a browser is already running WITHOUT --remote-debugging-port. " +
    "WARNING: unsaved input in the existing browser session will be lost. " +
    "Default false (preserves the user's current browser session)."
  ),
};
```

### 2. Kill ヘルパ (`src/utils/launch.ts` に追加)

`browser.ts` 内に置くと再利用できないので、`src/utils/launch.ts` に export する。spawnDetached と同じレイヤー。

```ts
import { spawnSync } from "node:child_process";

/**
 * Terminate all instances of the given executable name(s) via taskkill /F /IM.
 * Returns the list of exe names that actually had a process killed (taskkill exit 0).
 * Errors / "no process found" (exit 128) are silently ignored.
 *
 * Windows-only — uses taskkill.exe from System32.
 */
export function killProcessesByName(exeNames: string[]): string[] {
  const killed: string[] = [];
  for (const exe of exeNames) {
    try {
      const result = spawnSync("taskkill.exe", ["/F", "/IM", exe], {
        windowsHide: true,
        timeout: 5000,
      });
      if (result.status === 0) killed.push(exe);
      // exit 128 = "process not found" — ignore
      // other non-zero = log via stderr but don't throw
    } catch { /* ignore — best-effort */ }
  }
  return killed;
}
```

**判断: なぜ taskkill か**:
- PowerShell 子プロセス起動は ~300ms オーバーヘッド (memory: tray.ts は別目的)
- TerminateProcess (Win32 API) は koffi 経由で書けるが、PID 列挙が増える
- taskkill.exe は System32 標準、引数も `/F /IM exe` の単純形 → Win32 直叩きより堅牢
- 戻り値は exit code で判別可能（0=成功 / 128=該当なし / 1=他エラー）

### 3. Handler 拡張 (`src/tools/browser.ts:1371-1505`)

spawn の直前 (現 L1449「Spawn with CDP flags」セクション) に kill 処理を入れる。**alreadyRunning 判定の前ではない**ことが重要 — CDP が既に live なら kill する必要はない。

```ts
// ── 1. Already running? ── (既存、変更なし)
try {
  const existingTabs = await listTabs(port);
  // ...既存のロジック
} catch { /* not running — proceed to spawn */ }

// ── 2. Validate url early ── (既存、変更なし)

// ── 3. Resolve browser executable ── (既存、変更なし)

// ── 3.5. Kill existing if requested ── ★新規
let killed: string[] = [];
if (killExisting) {
  // 'auto' でも全候補ではなく chosenKey の exe のみ kill (副作用最小化)
  const exeToKill = chosenKey === "edge" ? "msedge.exe" : `${chosenKey}.exe`;
  killed = killProcessesByName([exeToKill]);
  if (killed.length > 0) {
    // grace period: kill 直後の spawn だと同じ user-data-dir のロックが残ることがある
    await new Promise<void>((r) => setTimeout(r, 500));
  }
}

// ── 4. Spawn with CDP flags ── (既存)
// ── 5. Poll listTabs ── (既存)

return {
  content: [{
    type: "text" as const,
    text: JSON.stringify({
      port,
      alreadyRunning: false,
      launched: { browser: chosenKey, path: chosenPath, userDataDir },
      killed, // ★ 追加
      tabs: pageTabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
    }, null, 2),
  }],
};
```

**alreadyRunning パスの戻り値にも `killed: []` を追加** (フィールド形を統一):

```ts
return {
  content: [{
    type: "text" as const,
    text: JSON.stringify({
      port,
      alreadyRunning: true,
      launched: null,
      killed: [],  // ★ 統一のため空配列を返す
      tabs: pageTabs.map(...),
    }, null, 2),
  }],
};
```

### 4. handler 引数の型拡張

```ts
export const browserLaunchHandler = async ({
  browser, port, userDataDir, url, waitMs, killExisting,
}: {
  browser: "auto" | "chrome" | "edge" | "brave";
  port: number;
  userDataDir: string;
  url?: string;
  waitMs: number;
  killExisting: boolean; // ★ 追加
}): Promise<ToolResult> => { ... }
```

---

## テスト

### ユニットテスト (`tests/unit/browser-launch-killexisting.test.ts` 新規)

`killProcessesByName` 関数を mock せずにテストするのは難しい (実 taskkill を呼ぶ)。3 段階で書く:

1. **`killProcessesByName` 単体**:
   - `spawnSync` を vitest の `vi.mock("node:child_process")` で mock
   - exit 0 → killed に含まれる、exit 128 → 含まれない、throw → 含まれない
   - 複数 exe 配列で全て呼ばれる

2. **schema 検証**:
   - `browserLaunchSchema` parse で `killExisting` がデフォルト false
   - `killExisting: "true"` (文字列) を coercedBoolean が boolean に変換

3. **handler フローのドライラン** (重い E2E は不要):
   - mock の `killProcessesByName` を呼ぶ前に alreadyRunning が true なら kill しない
   - chosenKey が edge のとき msedge.exe で呼ばれる、chrome のとき chrome.exe
   - `killExisting:false` (default) で kill が呼ばれない

E2E (実 Chrome を kill するシナリオ) は手動 smoke test で確認、自動化しない (CI で他テストの Chrome を巻き込む危険がある)。

---

## 影響範囲

### 触るファイル

| File | 変更内容 |
|---|---|
| `src/tools/browser.ts` | schema に 1 フィールド、handler に kill ステップ、戻り値に `killed[]` |
| `src/utils/launch.ts` | `killProcessesByName()` export 追加 |
| `tests/unit/browser-launch-killexisting.test.ts` | 新規 (上記 1+2+3) |

### 触らないファイル

- `src/stub-tool-catalog.ts`: `npm run generate-stub-catalog` 実行で**自動再生成**される。手動編集なし。
- `src/server-windows.ts`: 既存ツールの schema 拡張のみなので登録変更なし。
- README: 別 PR でツール表更新（本 PR では JSDoc / describe 文言で完結）。

---

## チェックリスト

- [ ] `src/utils/launch.ts` に `killProcessesByName()` 追加
- [ ] `src/tools/browser.ts` schema に `killExisting` 追加
- [ ] `src/tools/browser.ts` handler 引数型に `killExisting: boolean` 追加
- [ ] `src/tools/browser.ts` handler に kill ステップ挿入 (chosen exe のみ kill、500ms grace)
- [ ] `src/tools/browser.ts` 両 return に `killed[]` フィールド追加
- [ ] `tests/unit/browser-launch-killexisting.test.ts` 新規
- [ ] `npm run generate-stub-catalog` 実行 (auto-gen 反映)
- [ ] `npm run build` 通過
- [ ] `npm run test:capture > .vitest-out.txt` で全 unit pass
- [ ] Opus レビュー (CLAUDE.md 強制命令 3) → 指摘ゼロまで反復
- [ ] PR 出す (label: v1.1, closes #22)

---

## オープンクエスチョン

なし。ユーザー issue の仕様 (default false / 戻り値 `killed[]` / Windows のみ) に従う。
