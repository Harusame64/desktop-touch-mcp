/**
 * internal #371 — the name of the Windows Terminal tab this server's client runs in, so a paste is not
 * sent into it: the text would arrive as the user's next message to the client (win2, #764 P1-2).
 *
 * Measured by win2 (internal 2213f88b): the server's own console is a hidden one its cmd made, titled
 * "Windows PowerShell 5.1", and never the tab's name. The console of the ancestors that run in the pane
 * (claude.exe, the shell) carries the tab's name, status symbol included ("◐ win2" while working,
 * "✳ win2" idle), and lags behind the tab by about 2 s when the symbol changes. Those are the
 * ancestors whose console has a window. Reading another process's console needs AttachConsole, which
 * would take this server off its own console, so a short PowerShell helper reads it.
 *
 * Only when an ancestor is WindowsTerminal.exe. The maintainer's rule (2026-11-11): refuse only when the
 * tab is known to be the client's; when it cannot be read, say so and send.
 */

import { execFile } from "node:child_process";
import { buildProcessParentMap, getProcessIdentityByPid } from "./win32.js";

export type OwnTabTitle =
  | { state: "not_in_wt" }
  | { state: "title"; title: string }
  | { state: "unknown"; why: string };

// Short enough that a renamed tab or a client that changed its title is read again soon (gate 2 on
// #941); a failed read is kept longer, since each retry can take seconds.
const TITLE_TTL_MS = 15_000;
const UNKNOWN_TTL_MS = 30_000;
const HELPER_TIMEOUT_MS = 4_000;

let cache: { at: number; value: OwnTabTitle } | undefined;
let inflight: Promise<OwnTabTitle> | undefined;

/** The status symbols a client puts before its tab name are not part of the name: "◐ win2" is "win2". */
export function normalizeTabName(name: string): string {
  return name.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

/**
 * This process's ancestors below the first WindowsTerminal.exe, nearest first, or null when no ancestor
 * is Windows Terminal. `parentOf` and `nameOf` are the live readers by default.
 */
export function ancestorsBelowWt(
  startPid: number,
  parentOf: (pid: number) => number | undefined,
  nameOf: (pid: number) => string,
): number[] | null {
  const chain: number[] = [];
  let pid = startPid >>> 0;
  for (let depth = 0; depth < 32 && pid !== 0; depth++) {
    if (/^windowsterminal(\.exe)?$/i.test(nameOf(pid))) return chain;
    chain.push(pid);
    const next = parentOf(pid);
    if (next === undefined || next === pid) return null;
    pid = next;
  }
  return null;
}

/**
 * The helper: for each pid, attach to its console, and take the first whose console window is owned by
 * a Windows Terminal window (the pane's ConPTY): a launcher's own console, hidden but with a window,
 * must not answer for the tab (gate 2 on #941). The title is printed as base64 of its UTF-16 bytes: the
 * helper's stdout is encoded in the console's OEM code page, which turns "◐ 作業" into something
 * else (gate 2 on #941), and changing the code page would change the server's shared console.
 */
export function helperScript(pids: number[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$sig = @'",
    '[DllImport("kernel32.dll")] public static extern bool FreeConsole();',
    '[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);',
    '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();',
    '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetConsoleTitleW(System.Text.StringBuilder b, uint n);',
    '[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr h, uint flags);',
    '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr h, System.Text.StringBuilder b, int n);',
    "'@",
    "$k = Add-Type -MemberDefinition $sig -Name OwnTab -Namespace Dtm371 -PassThru",
    "$out = [Console]::Out",
    `foreach ($p in @(${pids.map((p) => p >>> 0).join(",")})) {`,
    "  [void]$k::FreeConsole()",
    "  if (-not $k::AttachConsole([uint32]$p)) { continue }",
    "  $w = $k::GetConsoleWindow()",
    "  if ($w -eq [System.IntPtr]::Zero) { continue }",
    "  $owner = $k::GetAncestor($w, 3)", // GA_ROOTOWNER
    "  $cls = New-Object System.Text.StringBuilder 256",
    "  [void]$k::GetClassNameW($owner, $cls, 256)",
    "  if ($cls.ToString() -ne 'CASCADIA_HOSTING_WINDOW_CLASS') { continue }",
    "  $sb = New-Object System.Text.StringBuilder 1024",
    "  [void]$k::GetConsoleTitleW($sb, 1024)",
    "  $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($sb.ToString()))",
    "  $out.Write('{\"pid\":' + $p + ',\"title16\":\"' + $b64 + '\"}')",
    "  exit 0",
    "}",
    "$out.Write('{\"none\":true}')",
  ].join("\n");
}

/** What the helper printed, as the answer. */
export function parseHelperOutput(stdout: string): OwnTabTitle {
  let parsed: { title16?: unknown; none?: unknown };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { state: "unknown", why: "the helper's answer could not be read" };
  }
  if (parsed.none === true) return { state: "unknown", why: "no ancestor's console belongs to a Windows Terminal window" };
  const title = typeof parsed.title16 === "string" ? Buffer.from(parsed.title16, "base64").toString("utf16le") : "";
  if (normalizeTabName(title) === "") return { state: "unknown", why: "the client's console title is empty" };
  return { state: "title", title };
}

function runHelper(pids: number[]): Promise<OwnTabTitle> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", helperScript(pids)],
      { windowsHide: true, timeout: HELPER_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout) => {
        if (err) resolve({ state: "unknown", why: `the helper failed (${(err as NodeJS.ErrnoException).code ?? err.message})` });
        else resolve(parseHelperOutput(stdout));
      },
    );
  });
}

/**
 * The client's tab name as its console carries it, cached (a minute for an answer, ten seconds for "could
 * not read", so a passing failure is retried).
 */
export async function ownTabTitle(now: () => number = Date.now): Promise<OwnTabTitle> {
  if (process.platform !== "win32") return { state: "not_in_wt" };
  if (cache && now() - cache.at < (cache.value.state === "unknown" ? UNKNOWN_TTL_MS : TITLE_TTL_MS)) return cache.value;
  if (inflight) return inflight;
  inflight = (async (): Promise<OwnTabTitle> => {
    let value: OwnTabTitle;
    try {
      const parents = buildProcessParentMap();
      // An empty map is a failed process snapshot, not "no ancestors": unknown, so the send says so
      // (agy on #941). A chain that ends at a process with no listed parent is the top of the tree.
      if (parents.size === 0) throw new Error("the process list could not be read");
      const chain = ancestorsBelowWt(process.pid, (p) => parents.get(p), (p) => getProcessIdentityByPid(p).processName);
      // Farthest first: the process right under Windows Terminal is attached to the tab's console by
      // construction; nearer ones may own consoles of their own (gate 2 on #941).
      value = chain === null ? { state: "not_in_wt" } : chain.length === 0
        ? { state: "unknown", why: "no process between this server and Windows Terminal" }
        : await runHelper([...chain].reverse());
    } catch (e) {
      value = { state: "unknown", why: `the ancestors could not be read (${e instanceof Error ? e.message : String(e)})` };
    }
    cache = { at: now(), value };
    return value;
  })();
  try {
    return await inflight;
  } finally {
    inflight = undefined;
  }
}

/** @internal For tests. */
export function _resetOwnTabTitleCache(): void {
  cache = undefined;
  inflight = undefined;
}
