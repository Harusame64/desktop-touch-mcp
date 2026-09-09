import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCachedUia, updateUiaCache } from "./layer-buffer.js";
import { AIM_WINDOW_GONE } from "./aim.js";
import { computeViewportPosition } from "../utils/viewport-position.js";
import { nativeUia, type NativeUiElement } from "./native-engine.js";
import { isExcludedTitle, isExcludedWindowHandle } from "./win32.js";
import { WindowExcludedError } from "./tool-exclusion.js";

const execFileAsync = promisify(execFile);

/**
 * (R3 tool-exclusion) UIA resolves a window from a TITLE STRING through the native UIA tree — a
 * subsystem that never consults the PID filter. So every UIA reader/driver that takes a
 * `windowTitle` must first refuse a title that names the key-locker window, else discover /
 * click_element / screenshot-som / workspace / macro can surface AND drive the secure dialog's
 * buttons by title (the exact driving leak tool-exclusion exists to close). Zero-overhead when no
 * locker is alive (`isExcludedTitle` short-circuits on an empty registry).
 */
function refuseUiaTitleIfExcluded(windowTitle: string): void {
  if (isExcludedTitle(windowTitle)) {
    throw new WindowExcludedError(
      `UIA target window "${windowTitle}" belongs to the desktop-touch key locker and is excluded`,
    );
  }
}

/**
 * (R3 tool-exclusion) The `options.hwnd` route below skips the title-based root search, so the
 * title check above no longer stands between a caller and the window it names. A caller holding
 * the locker's handle — or one that resolved it before the locker armed — would otherwise reach
 * the secure dialog with any benign title string attached. The handle registry is the same one
 * `enumWindowsInZOrder` consults, and it short-circuits to `false` when no locker is alive.
 */
function refuseUiaHwndIfExcluded(hwnd: bigint): void {
  if (isExcludedWindowHandle(hwnd)) {
    throw new WindowExcludedError(
      `UIA target window handle ${hwnd} belongs to the desktop-touch key locker and is excluded`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Native UIA Engine (Rust) — consumed via ./native-engine.js (single load point).
// When nativeUia is null, every call site below falls back to PowerShell.
// ─────────────────────────────────────────────────────────────────────────────

if (!nativeUia) {
  console.warn("[uia-bridge] Native UIA engine not available — using PowerShell fallback");
}

/**
 * Escape a string for use inside a PowerShell single-quoted string literal.
 * In PowerShell single-quoted strings, the only special character is ' itself,
 * which must be doubled to ''.
 */
export function escapePS(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Escape a string for use in a PowerShell -like pattern inside single quotes.
 * Escapes -like wildcard metacharacters (*, ?, [, ], `) with a PowerShell backtick,
 * then also escapes single quotes for the string literal.
 *
 * Use for values placed inside -like '*${escapeLike(userInput)}*' patterns.
 * Values used with -eq do NOT need this — use escapePS() instead.
 */
export function escapeLike(s: string): string {
  // Escape backtick first to avoid double-escaping, then wildcards
  return s.replace(/[`*?[\]]/g, (ch) => "`" + ch).replace(/'/g, "''");
}

/** Execute a PowerShell script string and return stdout */
export async function runPS(script: string, timeoutMs = 8000): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: timeoutMs, windowsHide: true }
  );
  return stdout.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scripts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process start plus two `Add-Type` assembly loads, before the script's own clock starts.
 * Subtracted from the caller's deadline to get the walk's budget, so the script always finishes
 * and prints inside the wait around it.
 */
const PS_STARTUP_HEADROOM_MS = 4000;
/** Enough to reach a first element and print. Below this the walk is not worth starting. */
const PS_MIN_TREE_BUDGET_MS = 1000;

/**
 * ADR-036 — how long the script may walk, given how long the caller is willing to wait.
 *
 * These were both 8000 and independent, so a walk that used its budget was killed by the wait
 * before it could print: the caller got nothing instead of a truncated tree (2ゲート目の指摘).
 * Raising the wait to clear the budget fixed that and broke the other direction — `workspace.ts`
 * asks for 2000 ms and `_narration.ts` for 4000 ms deliberately, and neither should wait twelve
 * seconds because this file has an opinion (PR 側の codex). So the budget follows the deadline.
 *
 * A deadline shorter than the startup headroom cannot hold a walk at all; the floor keeps the
 * script from being asked for a walk it could not begin, and the wait outside ends it. Nothing
 * here can make a 500 ms deadline produce a tree.
 *
 * Gate 2 asked for the PowerShell path to be skipped outright in that case — `workspace.ts`
 * passes 2000 ms, so the process is spawned and killed before its first statement. Not taken,
 * and the reason is worth keeping: **4000 is an estimate of process start plus two `Add-Type`
 * loads, not a measured floor.** Refusing work on an estimate turns a guess into a gate, and on
 * a machine where PowerShell starts in well under a second it would disable reads that would
 * have returned. What it wants first is a measurement on the real machine; until there is one,
 * the outer wait ends the attempt, which is what a caller who asked for 2000 ms is entitled to.
 */
export function psTreeBudgetMs(timeoutMs: number): number {
  return Math.max(PS_MIN_TREE_BUDGET_MS, timeoutMs - PS_STARTUP_HEADROOM_MS);
}

/**
 * ADR-036 — how long to wait on a script that has no clock of its own.
 *
 * The twin of `psTreeBudgetMs`, for the other shape of read. The tree walk carries a stopwatch
 * and can be told to stop early, so its budget is cut to fit the caller's deadline; the
 * TextPattern read is a single `FindAll(Descendants)` followed by `GetText`, and neither can be
 * interrupted, so nothing inside the script can be shortened. What moves instead is the wait.
 *
 * Without this, `getTextViaTextPattern`'s default 6000 ms had the process start taken out of it
 * before the script's first statement ran, leaving a fraction of the deadline for the read
 * itself — and a timeout here returns `null`, which the terminal provider reports as "no buffer"
 * rather than "not read in time" (2ゲート目の指摘). It bites hardest on the case this ADR is
 * about: the scoped read exists for the same-titled pair, and that is where the PowerShell path
 * is taken at all.
 *
 * The parameter then means the same thing on both roads: how long the READ may take. The native
 * path already read it that way — it pays no process start — so the two only agreed by accident
 * before.
 */
export function psReadWaitMs(readBudgetMs: number): number {
  return readBudgetMs + PS_STARTUP_HEADROOM_MS;
}

function makeGetElementsScript(
  windowTitle: string,
  maxDepth: number,
  maxElements: number,
  fetchValues = false,
  /**
   * ADR-036 — when the caller resolved a handle, the read is scoped to that window through
   * `FromHandle`, the same door `makeClickElementScriptByHwnd` uses. Without it the read half
   * kept picking the first window whose title matched while the write half addressed the
   * handle, so `desktop_discover` could enumerate one window and `desktop_act` drive another.
   */
  hwnd?: bigint,
  /** How long the walk may run — see `psTreeBudgetMs`. Always shorter than the wait outside. */
  budgetMs: number = PS_MIN_TREE_BUDGET_MS,
): string {
  const safeTitle = escapeLike(windowTitle);
  const fetchValuesBlock = fetchValues
    ? `
    $elVal = $null
    try {
        $vp2 = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $vp2) { $elVal = $vp2.Current.Value }
    } catch {}`
    : "";
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root  = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition

${hwnd !== undefined
  ? `# ADR-036: the caller named a window by handle, so no title search happens here.
# FromHandle THROWS (ElementNotAvailableException) for a handle whose window has gone, rather
# than returning null — and on the read path handles are stored and reused across calls, so a
# window closing between two of them is routine. Without the catch the caller got empty stdout
# and a JSON parse error instead of this sentence (2ゲート目の指摘).
$hwndPtr = [System.IntPtr]::new(${hwnd.toString()})
try { $target = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr) }
catch { Write-Output '{"error":"Window not found by hwnd"}'; exit }
if (-not $target) { Write-Output '{"error":"Window not found by hwnd"}'; exit }`
  : `# Find window by partial title (live query — before cache scope)
$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"error":"Window not found"}'; exit }`}
$winTitle     = $target.Current.Name
$winClassName = $target.Current.ClassName

# Capture window bounding rect for the caller
$winRect = $null
try {
    $wr = $target.Current.BoundingRectangle
    if (-not $wr.IsEmpty -and -not [double]::IsInfinity($wr.X)) {
        $winRect = @{ x=[int]$wr.X; y=[int]$wr.Y; width=[int]$wr.Width; height=[int]$wr.Height }
    }
} catch {}

$cvWalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$results  = [System.Collections.Generic.List[object]]::new()
$count    = 0
$sw       = [System.Diagnostics.Stopwatch]::StartNew()

$stack = [System.Collections.Generic.Stack[object]]::new()
$first = $cvWalker.GetFirstChild($target)
if ($null -ne $first) { $stack.Push(@{ el=$first; depth=0 }) }

# Patterns we care about (subset of all UIA patterns)
$wantedPats = [System.Collections.Generic.HashSet[string]]::new()
$wantedPats.Add('InvokePattern') > $null; $wantedPats.Add('ValuePattern') > $null
$wantedPats.Add('ExpandCollapsePattern') > $null; $wantedPats.Add('SelectionItemPattern') > $null
$wantedPats.Add('TogglePattern') > $null; $wantedPats.Add('ScrollPattern') > $null

while ($stack.Count -gt 0 -and $count -lt ${maxElements} -and $sw.ElapsedMilliseconds -lt ${budgetMs}) {
    $item  = $stack.Pop()
    $el    = $item.el
    $depth = $item.depth

    # Push next sibling first so it waits until children are exhausted (correct DFS pre-order)
    try {
        $next = $cvWalker.GetNextSibling($el)
        if ($null -ne $next) { $stack.Push(@{ el=$next; depth=$depth }) }
    } catch {}

    # Skip offscreen elements — prune subtree (children will also be offscreen)
    $offscreen = $false
    try { $offscreen = $el.Current.IsOffscreen } catch {}
    if ($offscreen) { continue }

    # Extract properties via live Current.* access
    $r    = $null
    try { $r = $el.Current.BoundingRectangle } catch {}
    $rect = $null
    if ($null -ne $r -and -not $r.IsEmpty -and -not ([double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Y) -or [double]::IsInfinity($r.Width) -or [double]::IsInfinity($r.Height)) -and -not [double]::IsNaN($r.X) -and $r.Width -gt 0 -and $r.Height -gt 0) {
        $rect = @{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height }
    }

    # One RPC for all patterns instead of six exception-path probes
    $pats = [System.Collections.Generic.List[string]]::new()
    try {
        foreach ($p in $el.GetSupportedPatterns()) {
            $pn = $p.ProgrammaticName -replace 'Identifiers\\.Pattern', ''
            if ($wantedPats.Contains($pn)) { $pats.Add($pn) }
        }
    } catch {}

    $ctName = ''
    try { $ctName = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\\.', '' } catch {}

    $elName = ''; try { $elName = $el.Current.Name } catch {}
    $elAid  = ''; try { $elAid  = $el.Current.AutomationId } catch {}
    $elCls  = ''; try { $elCls  = $el.Current.ClassName } catch {}
    $elEna  = $false; try { $elEna = $el.Current.IsEnabled } catch {}

    ${fetchValuesBlock}
    $elObj = @{
        name         = $elName
        controlType  = $ctName
        automationId = $elAid
        className    = $elCls
        isEnabled    = $elEna
        boundingRect = $rect
        patterns     = [string[]]($pats.ToArray())
        depth        = $depth
    }
    if ($null -ne $elVal) { $elObj['value'] = $elVal }
    $results.Add($elObj)
    $count++

    # Push first child after sibling so child is popped next (depth-first)
    if ($depth -lt ${maxDepth}) {
        try {
            $child = $cvWalker.GetFirstChild($el)
            if ($null -ne $child) { $stack.Push(@{ el=$child; depth=($depth+1) }) }
        } catch {}
    }
}

@{ windowTitle=$winTitle; windowClassName=$winClassName; windowRect=$winRect; elementCount=$results.Count; elements=$results.ToArray() } | ConvertTo-Json -Depth 6 -Compress
`;
}

/**
 * ADR-036 — why there is no "do we really need to scope this?" predicate here any more.
 *
 * There was one. It asked whether the Win32 enumeration showed exactly one window whose caption
 * matched the query and it was the pinned one, and skipped scoping when it did — because
 * scoping costs a PowerShell round trip (184 ms against 517 ms on the same window, measured
 * 2026-09-09) and `normalizeTarget` fills a handle for every call, so the price was paid on
 * every `desktop_discover`.
 *
 * Both gates refused it, one round apart, for the same two reasons:
 *
 *   - **it is not atomic.** The enumeration is a photograph; the read happens after it. A
 *     same-titled window appearing in between turns a checked title into an ambiguous one and
 *     nothing notices.
 *   - **the populations differ.** The predicate reads Win32 captions from an enumeration that
 *     drops invisible, untitled and sub-50 px windows; the search matches UIA `Name` over the
 *     root children, and the two are not always the same string (measured — a WPF window whose
 *     `Name` was its content, not its caption).
 *
 * Both ways of being wrong land in exactly the case this ADR is about, and the result is a read
 * of one window feeding actions aimed at another — which is the split the ADR closed. No cheap
 * verification exists either: two maximized same-titled windows have the same class and the same
 * rect, so nothing the read returns can tell them apart.
 *
 * So a pinned read is scoped, always, and the round trip is the price until the native side
 * takes a handle — `uiaGetElements` / `uiaGetTextViaTextPattern` take a title and nothing else,
 * and giving them one removes the cost and the question together.
 */

/**
 * (H3) Click an element by finding the window via HWND directly.
 * AutomationElement.FromHandle() bypasses the title-based root search,
 * which fixes WindowNotFound for common dialogs whose title is not visible
 * in the root children list (e.g. Save As on Windows 11 Notepad).
 */
function makeClickElementScriptByHwnd(
  hwnd: bigint,
  name: string | undefined,
  automationId: string | undefined,
  controlType: string | undefined
): string {
  const nameFilter = name ? `$c.Name -like '*${escapeLike(name)}*'` : "$true";
  const idFilter = automationId ? `$c.AutomationId -eq '${escapePS(automationId)}'` : "$true";
  const typeFilter = controlType
    ? `$c.ControlType.ProgrammaticName -like '*${escapeLike(controlType)}*'`
    : "$true";

  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# ADR-036: FromHandle THROWS (ElementNotAvailableException) for a handle whose window has
# gone, rather than returning null — and the aim is held across calls, so a window closing
# between two of them is routine. Without the catch the script died with empty stdout, the
# caller got a JSON parse error, and the executor read that as an ordinary UIA failure and
# clicked the rect the window used to occupy (2ゲート目の指摘). The read half has had this
# catch since 505290d; this is its twin.
$hwndPtr = [System.IntPtr]::new(${hwnd.toString()})
try { $target = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr) }
catch { Write-Output '{"ok":false,"error":"Window not found by hwnd","code":"${AIM_WINDOW_GONE}"}'; exit }
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found by hwnd","code":"${AIM_WINDOW_GONE}"}'; exit }

$desc  = [System.Windows.Automation.TreeScope]::Descendants
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$found = $null
$all   = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter}) -and (${typeFilter})) { $found = $el; break }
}
if (-not $found) { Write-Output '{"ok":false,"error":"Element not found"}'; exit }

try {
    if (-not $found.Current.IsEnabled) {
        Write-Output '{"ok":false,"error":"Element is disabled"}'; exit
    }
} catch {}

$ip = $null
if (-not $found.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
    Write-Output '{"ok":false,"error":"InvokePattern not supported by this element"}'; exit
}
try {
    $ip.Invoke()
    Write-Output ('{"ok":true,"element":"' + $found.Current.Name + '"}')
} catch {
    Write-Output ('{"ok":false,"error":"' + $_.Exception.Message + '"}')
}
`;
}

/**
 * (H3) Set a value on an element by finding the window via HWND directly.
 */
function makeSetValueScriptByHwnd(
  hwnd: bigint,
  name: string | undefined,
  automationId: string | undefined,
  value: string
): string {
  const nameFilter = name ? `$c.Name -like '*${escapeLike(name)}*'` : "$true";
  const idFilter = automationId ? `$c.AutomationId -eq '${escapePS(automationId)}'` : "$true";
  const escaped = escapePS(value);

  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# ADR-036: FromHandle THROWS (ElementNotAvailableException) for a handle whose window has
# gone, rather than returning null — and the aim is held across calls, so a window closing
# between two of them is routine. Without the catch the script died with empty stdout, the
# caller got a JSON parse error, and the executor read that as an ordinary UIA failure and
# clicked the rect the window used to occupy (2ゲート目の指摘). The read half has had this
# catch since 505290d; this is its twin.
$hwndPtr = [System.IntPtr]::new(${hwnd.toString()})
try { $target = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr) }
catch { Write-Output '{"ok":false,"error":"Window not found by hwnd","code":"${AIM_WINDOW_GONE}"}'; exit }
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found by hwnd","code":"${AIM_WINDOW_GONE}"}'; exit }

$desc  = [System.Windows.Automation.TreeScope]::Descendants
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$found = $null
$all   = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter})) { $found = $el; break }
}
if (-not $found) { Write-Output '{"ok":false,"error":"Element not found"}'; exit }

try {
    $vp = $found.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue('${escaped}')
    Write-Output '{"ok":true}'
} catch {
    Write-Output ('{"ok":false,"error":"' + $_.Exception.Message + '"}')
}
`;
}

function makeClickElementScript(
  windowTitle: string,
  name: string | undefined,
  automationId: string | undefined,
  controlType: string | undefined
): string {
  const safeTitle = escapeLike(windowTitle);
  const nameFilter = name ? `$c.Name -like '*${escapeLike(name)}*'` : "$true";
  const idFilter = automationId ? `$c.AutomationId -eq '${escapePS(automationId)}'` : "$true";
  const typeFilter = controlType
    ? `$c.ControlType.ProgrammaticName -like '*${escapeLike(controlType)}*'`
    : "$true";

  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$desc  = [System.Windows.Automation.TreeScope]::Descendants

$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found"}'; exit }

$found = $null
$all = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter}) -and (${typeFilter})) {
        $found = $el; break
    }
}
if (-not $found) { Write-Output '{"ok":false,"error":"Element not found"}'; exit }

# Phase 2.2 — pre-detect disabled clicks so the LLM gets ElementDisabled + suggest
# rather than a silent success that did nothing visible.
try {
    if (-not $found.Current.IsEnabled) {
        Write-Output '{"ok":false,"error":"Element is disabled"}'; exit
    }
} catch {}

$ip = $null
if (-not $found.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
    Write-Output '{"ok":false,"error":"InvokePattern not supported by this element"}'; exit
}
try {
    $ip.Invoke()
    Write-Output ('{"ok":true,"element":"' + $found.Current.Name + '"}')
} catch {
    Write-Output ('{"ok":false,"error":"' + $_.Exception.Message + '"}')
}
`;
}

function makeSetValueScript(
  windowTitle: string,
  name: string | undefined,
  automationId: string | undefined,
  value: string
): string {
  const safeTitle = escapeLike(windowTitle);
  const nameFilter = name ? `$c.Name -like '*${escapeLike(name)}*'` : "$true";
  const idFilter = automationId ? `$c.AutomationId -eq '${escapePS(automationId)}'` : "$true";
  const escaped = escapePS(value);

  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$desc  = [System.Windows.Automation.TreeScope]::Descendants

$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found"}'; exit }

$found = $null
$all = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter})) { $found = $el; break }
}
if (-not $found) { Write-Output '{"ok":false,"error":"Element not found"}'; exit }

try {
    $vp = $found.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue('${escaped}')
    Write-Output '{"ok":true}'
} catch {
    Write-Output ('{"ok":false,"error":"' + $_.Exception.Message + '"}')
}
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface UiElement {
  name: string;
  controlType: string;
  automationId: string;
  className?: string;
  isEnabled: boolean;
  boundingRect: { x: number; y: number; width: number; height: number } | null;
  patterns: string[];
  depth: number;
  /** Present only when getUiElements was called with fetchValues:true. */
  value?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Focused element / element-at-point (for desktop_state & post narration)
// ─────────────────────────────────────────────────────────────────────────────

export interface UiaFocusInfo {
  name: string;
  controlType: string;
  automationId?: string;
  /** Present for focused element when ValuePattern is supported. */
  value?: string;
}

/**
 * Should a focused / at-point row be dropped? (#352 follow-up, ADR-022 §5.5)
 *
 * A `name`-empty row is dropped by DEFAULT — this is the historical behavior and
 * keeps `_mouse-verify` / `desktop_state` / perception byte-equal (none of them
 * pass `includeUnnamed`). The advisory/post path (`_post.ts snapshotFocusedElement`)
 * opts in with `includeUnnamed:true` so an UNNAMED text input (many real
 * Edit/Document fields expose ValuePattern with an empty Name) can reach the #352
 * advisory gate. Even when opted in, a degenerate row (no name AND no controlType)
 * is still dropped. Single predicate so the native + PS guards cannot drift.
 */
function dropFocusRow(
  name: string | undefined,
  controlType: string | undefined,
  includeUnnamed: boolean
): boolean {
  return includeUnnamed ? (!name && !controlType) : !name;
}

/**
 * Run a single PowerShell script that returns both:
 *   focused — the element that currently has keyboard focus (FocusedElement)
 *   atPoint — the element under screen coordinates (x, y)  [skipped when includePoint=false]
 *
 * Both are normalized via TreeWalker.ControlViewWalker to reach the nearest
 * addressable control (avoids landing on raw Pane descendants).
 *
 * Timeout is intentionally short (default 2 s) — these are non-essential fields;
 * null is acceptable when UIA is unavailable or slow.
 *
 * `includeUnnamed` (default false): see {@link dropFocusRow}. Only the advisory/post
 * path opts in; all other callers keep the name-empty drop (byte-equal).
 */
export async function getFocusedAndPointInfo(
  x = 0,
  y = 0,
  includePoint = true,
  timeoutMs = 2000,
  includeUnnamed = false
): Promise<{ focused: UiaFocusInfo | null; atPoint: UiaFocusInfo | null }> {
  // ★ Rust native path
  if (nativeUia?.uiaGetFocusedAndPoint) {
    try {
      const safeX = Number.isFinite(x) ? Math.trunc(x) : 0;
      const safeY = Number.isFinite(y) ? Math.trunc(y) : 0;
      const result = await nativeUia.uiaGetFocusedAndPoint({
        cursorX: safeX,
        cursorY: safeY,
      });
      const toInfo = (obj: { name: string; controlType: string; automationId?: string; value?: string } | null | undefined): UiaFocusInfo | null => {
        if (!obj || dropFocusRow(obj.name, obj.controlType, includeUnnamed)) return null;
        const info: UiaFocusInfo = { name: obj.name, controlType: obj.controlType ?? "" };
        if (obj.automationId) info.automationId = obj.automationId;
        if (obj.value != null) info.value = obj.value;
        return info;
      };
      return {
        focused: toInfo(result.focused),
        atPoint: includePoint ? toInfo(result.atPoint) : null,
      };
    } catch (e) {
      console.warn("[uia-bridge] Native uiaGetFocusedAndPoint failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback
  const safeX = Number.isFinite(x) ? Math.trunc(x) : 0;
  const safeY = Number.isFinite(y) ? Math.trunc(y) : 0;
  const includePointPS = includePoint ? "true" : "false";
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$result = @{ focused = $null; atPoint = $null }

# Focused element
try {
    $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -ne $fe) {
        $fe = $walker.Normalize($fe)
        $fn = ''; try { $fn = $fe.Current.Name } catch {}
        $fc = ''; try { $fc = $fe.Current.ControlType.ProgrammaticName -replace 'ControlType\\.',''; } catch {}
        $fa = ''; try { $fa = $fe.Current.AutomationId } catch {}
        $fv = $null
        try {
            $fvp = $fe.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($null -ne $fvp) { $fv = $fvp.Current.Value }
        } catch {}
        $fo = @{ name=$fn; controlType=$fc; automationId=$fa }
        if ($null -ne $fv) { $fo['value'] = $fv }
        $result.focused = $fo
    }
} catch {}

# Element at cursor point (optional)
if (${includePointPS}) {
    try {
        $pt = [System.Windows.Point]::new(${safeX}, ${safeY})
        $ep = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
        if ($null -ne $ep) {
            $ep = $walker.Normalize($ep)
            $en = ''; try { $en = $ep.Current.Name } catch {}
            $ec = ''; try { $ec = $ep.Current.ControlType.ProgrammaticName -replace 'ControlType\\.',''; } catch {}
            $ea = ''; try { $ea = $ep.Current.AutomationId } catch {}
            $result.atPoint = @{ name=$en; controlType=$ec; automationId=$ea }
        }
    } catch {}
}

$result | ConvertTo-Json -Compress
`;
  try {
    const output = await runPS(script, timeoutMs);
    const parsed = JSON.parse(output) as {
      focused?: Record<string, string | undefined> | null;
      atPoint?: Record<string, string | undefined> | null;
    };
    const toInfo = (obj: Record<string, string | undefined> | null | undefined): UiaFocusInfo | null => {
      if (!obj || dropFocusRow(obj.name, obj.controlType, includeUnnamed)) return null;
      const info: UiaFocusInfo = { name: obj.name ?? "", controlType: obj.controlType ?? "" };
      if (obj.automationId) info.automationId = obj.automationId;
      if (obj.value != null) info.value = obj.value;
      return info;
    };
    return { focused: toInfo(parsed.focused), atPoint: toInfo(parsed.atPoint) };
  } catch {
    return { focused: null, atPoint: null };
  }
}

/**
 * Lightweight focused-element query — skips the FromPoint work.
 * Intended for the perception UIA sensor loop; bounded at 500ms to limit cost.
 *
 * @param _hwnd      Reserved for future per-window filtering (currently ignored —
 *                   UIA FocusedElement is system-global).
 * @param timeoutMs  PowerShell timeout (default 500ms vs 2000ms in getFocusedAndPointInfo).
 */
export async function getFocusedElement(_hwnd?: bigint, timeoutMs = 500): Promise<UiaFocusInfo | null> {
  // ★ Rust native path
  if (nativeUia?.uiaGetFocusedElement) {
    try {
      const result = await nativeUia.uiaGetFocusedElement();
      if (!result || !result.name) return null;
      const info: UiaFocusInfo = { name: result.name, controlType: result.controlType ?? "" };
      if (result.automationId) info.automationId = result.automationId;
      if (result.value != null) info.value = result.value;
      return info;
    } catch (e) {
      console.warn("[uia-bridge] Native uiaGetFocusedElement failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback
  const { focused } = await getFocusedAndPointInfo(0, 0, false, timeoutMs);
  return focused;
}

export interface UiElementsResult {
  windowTitle: string;
  /** ClassName of the root window element — used for WinUI3 detection. */
  windowClassName?: string;
  /** Bounding rectangle of the root window in screen coordinates. */
  windowRect?: { x: number; y: number; width: number; height: number } | null;
  elementCount: number;
  elements: UiElement[];
}

export async function getUiElements(
  windowTitle: string,
  maxDepth = 3,
  maxElements = 50,
  timeoutMs = 10000,
  options?: {
    cached?: boolean;
    /**
     * Cache key only — which window's tree a title-derived result files under. Does not scope
     * the read, and is the caller's claim that its title names this window.
     */
    hwnd?: bigint;
    /**
     * ADR-036 — scope the read to this window, through `FromHandle`.
     *
     * Separate from `hwnd` because the two are different requests and were briefly the same
     * parameter: `screenshot` and `get_ui_elements` pass a handle to key the cache, and making
     * that scope the read took the Rust path away from them (a cache miss then paid a
     * PowerShell round trip and could exceed its 8 s cap, returning nothing on a deep tree).
     * Two things that are not the same thing do not share a name.
     *
     * It keys the cache too, but only when it actually scoped the read — see `cacheKey` below.
     */
    pinnedHwnd?: bigint;
    fetchValues?: boolean;
  }
): Promise<UiElementsResult & { _cacheHit?: boolean }> {
  refuseUiaTitleIfExcluded(windowTitle);
  if (options?.pinnedHwnd !== undefined) refuseUiaHwndIfExcluded(options.pinnedHwnd);
  // Cache hit path — only when caller provides a handle + cached:true. It is probed BEFORE the
  // scoping gate below, because that gate is a full `enumWindowsInZOrder()` sweep (a handful of
  // syscalls per top-level window) and a hit does not need it: the cached tree was filed under
  // this handle by whoever read it, and nothing about that changes with what is on screen now
  // (2ゲート目の指摘). Note: cache is never used when fetchValues:true (values may have changed).
  const probeKey = options?.hwnd ?? options?.pinnedHwnd;
  if (options?.cached && probeKey !== undefined && !options.fetchValues) {
    const cached = getCachedUia(probeKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as UiElementsResult;
        return { ...parsed, _cacheHit: true };
      } catch {
        // fall through to live fetch
      }
    }
  }
  // A pinned read is scoped to the handle. Always — see the note above the scripts.
  const scopeHwnd = options?.pinnedHwnd;
  // A tree is filed under a handle only when the read was SCOPED to that handle — a scoped read
  // is the only one that can vouch for which window it describes. A title-derived tree still
  // files under `hwnd`, which is the caller's own claim that the title it passed names that
  // window; that claim is as old as the cache and is not what this ADR changed. What is not
  // allowed is the bridge inventing the claim out of a scoping request (2ゲート目の指摘).
  const cacheKey = scopeHwnd ?? options?.hwnd;
  // ★ Rust native path
  //
  // ADR-036 — skipped only when the read is SCOPED to a handle, the same way `clickElement`
  // and `setElementValue` skip it: `uiaGetElements` takes a title and nothing else, so going
  // through it would read whichever window the title found first while every write on this
  // session addressed the handle. The two halves disagreeing is worse than the PowerShell
  // round-trip: a read of window A and a click on window B report `no_change` for an action
  // that landed. A handle passed merely to key the cache keeps the native path. When the
  // native side grows a handle parameter this branch goes away.
  if (nativeUia?.uiaGetElements && scopeHwnd === undefined) {
    try {
      const result = await nativeUia.uiaGetElements({
        windowTitle,
        maxDepth,
        maxElements,
        fetchValues: options?.fetchValues ?? false,
      });
      // Normalise: Rust returns Option<T> as undefined; TS expects null for rects
      const normalised: UiElementsResult = {
        windowTitle: result.windowTitle,
        windowClassName: result.windowClassName ?? undefined,
        windowRect: result.windowRect ?? null,
        elementCount: result.elementCount,
        elements: result.elements.map((el: NativeUiElement) => ({
          ...el,
          boundingRect: el.boundingRect ?? null,
        })),
      };
      if (cacheKey !== undefined) {
        try { updateUiaCache(cacheKey, JSON.stringify(normalised)); } catch { /* ignore */ }
      }
      return normalised;
    } catch (e) {
      console.warn("[uia-bridge] Native uiaGetElements failed, falling back to PowerShell:", e);
      // fall through to PowerShell
    }
  }

  // PowerShell fallback (existing implementation)
  const script = makeGetElementsScript(
    windowTitle,
    maxDepth,
    maxElements,
    options?.fetchValues ?? false,
    scopeHwnd,
    psTreeBudgetMs(timeoutMs),
  );
  // The script walks the tree under its own 8 s budget and then prints. Killing the process at
  // the same 8 s means a saturated walk produces nothing at all rather than a truncated answer,
  // so the outer wait has to be the longer one (2ゲート目の指摘).
  const output = await runPS(script, timeoutMs);
  const result = JSON.parse(output);
  if (result.error) throw new Error(result.error);

  if (cacheKey !== undefined) {
    try { updateUiaCache(cacheKey, output); } catch { /* ignore */ }
  }
  return result as UiElementsResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action-oriented element extraction
// ─────────────────────────────────────────────────────────────────────────────

/** Action type derived from UIA interaction patterns. */
export type ElementAction = "click" | "type" | "expand" | "select" | "scroll" | "read";

export interface ActionableElement {
  /** Primary action available on this element. */
  action: ElementAction;
  /** Element label (name or automationId). */
  name: string;
  /** UIA control type (Button, Edit, MenuItem, etc.). */
  type: string;
  /** Pre-computed center coordinate — pass directly to mouse_click. */
  clickAt: { x: number; y: number };
  /** Full bounding rectangle in screen coordinates. */
  region: { x: number; y: number; width: number; height: number };
  /** Current text value (for Edit/Document/ComboBox with ValuePattern). */
  value?: string;
  /** AutomationId for use with click_element or set_element_value. */
  id?: string;
  /** False if the element is disabled (grayed out). */
  enabled?: boolean;
  /** Origin of this element's data: 'uia' = UI Automation, 'ocr' = Windows OCR. */
  source?: "uia" | "ocr";
  /** Phase 2.2 — semantic state: enabled / disabled / toggled / readonly. */
  state?: "enabled" | "disabled" | "toggled" | "readonly";
  /** Phase 2.3 / 3.3 — match-confidence on a unified 0-1 scale. */
  confidence?: number;
  /** Optional next-step hint for low-confidence items. */
  suggest?: string;
  /** Position of this element relative to the window/viewport. */
  viewportPosition?: "in-view" | "above" | "below" | "left" | "right";
  /** Normalised vertical position on the page (0 = top, 1 = bottom). Only filled by scroll({action:'smart'}). */
  pageRatio?: number;
}

export interface TextContent {
  content: string;
  /** Top-left of the text element in screen coordinates. */
  at: { x: number; y: number };
}

export interface ActionableResult {
  window: string;
  /** ClassName of the root window element (from UIA). */
  windowClassName?: string;
  windowRegion?: { x: number; y: number; width: number; height: number };
  /** Interactive elements sorted by screen position (top→bottom, left→right). */
  actionable: ActionableElement[];
  /** Static text labels extracted from Text/Pane elements. */
  texts: TextContent[];
}

/** ClassName regex for WinUI3 / Windows App SDK windows. */
export const WINUI3_CLASS_RE = /^(WinUIDesktop|Microsoft\.UI\.|ApplicationFrameWindow)/i;

/** Derive the primary action from a list of UIA pattern names. */
function deriveAction(patterns: string[], controlType: string): ElementAction | null {
  const p = patterns.map((s) => s.toLowerCase());
  const ct = controlType.toLowerCase();

  if (p.includes("valuepattern") && (ct === "edit" || ct === "document" || ct === "combobox")) return "type";
  if (p.includes("invokepattern") || ct === "button" || ct === "hyperlink") return "click";
  if (p.includes("expandcollapsepattern")) return "expand";
  if (p.includes("selectionitempattern") || ct === "listitem" || ct === "radiobutton") return "select";
  if (p.includes("scrollpattern")) return "scroll";
  if (ct === "menuitem" || ct === "menubaritem") return "click";
  if (ct === "tab" || ct === "tabitem") return "click";
  if (ct === "checkbox") return "click";
  return null;
}

/**
 * Transform raw UIA elements into action-oriented format.
 * Filters to elements with screen coordinates and meaningful interactions.
 */
export function extractActionableElements(result: UiElementsResult): ActionableResult {
  const actionable: ActionableElement[] = [];
  const texts: TextContent[] = [];

  for (const el of result.elements) {
    const r = el.boundingRect;
    if (!r || r.width < 4 || r.height < 4) continue;  // skip invisible/off-screen

    const clickAt = {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
    };

    // Extract static text separately
    if (el.controlType === "Text" && el.name && el.name.trim()) {
      texts.push({ content: el.name.trim(), at: { x: r.x, y: r.y } });
      continue;
    }

    // PS 5.1 ConvertTo-Json bug: single-element arrays may serialize as scalars
    const patterns = Array.isArray(el.patterns)
      ? el.patterns
      : el.patterns ? [el.patterns as unknown as string] : [];
    const action = deriveAction(patterns, el.controlType);
    if (!action) continue;

    const label = el.name || el.automationId || el.controlType;
    if (!label) continue;

    // Phase 3.3 — synthetic UIA confidence:
    //   automationId present  → 1.0
    //   Name (full)           → 0.95
    //   Name (substring/short)→ 0.7
    //   ControlType-only label→ 0.5
    let confidence = 0.5;
    if (el.automationId) confidence = 1.0;
    else if (el.name && el.name.length > 1 && el.name === label) confidence = 0.95;
    else if (el.name && label === el.name) confidence = 0.7;

    // Phase 2.2 — semantic state.
    const state: ActionableElement["state"] = el.isEnabled ? "enabled" : "disabled";

    const item: ActionableElement = {
      action,
      name: label,
      type: el.controlType,
      clickAt,
      region: { x: r.x, y: r.y, width: r.width, height: r.height },
      source: "uia",
      state,
      confidence,
    };

    if (el.automationId) item.id = el.automationId;
    if (!el.isEnabled) item.enabled = false;

    if (result.windowRect) {
      item.viewportPosition = computeViewportPosition(
        { x: r.x, y: r.y, width: r.width, height: r.height },
        result.windowRect
      );
    }

    actionable.push(item);
  }

  // Sort by vertical position, then horizontal
  actionable.sort((a, b) =>
    a.region.y !== b.region.y ? a.region.y - b.region.y : a.region.x - b.region.x
  );

  // Use windowRect from PS output (preferred), fall back to searching elements.
  // Normalise null → undefined so the field is absent (not null) when unknown.
  const windowRegion = (result.windowRect != null ? result.windowRect
    : result.elements.find((e) => e.controlType === "Window")?.boundingRect) ?? undefined;

  return {
    window: result.windowTitle,
    windowClassName: result.windowClassName,
    windowRegion,
    actionable,
    texts,
  };
}

export async function clickElement(
  windowTitle: string,
  name?: string,
  automationId?: string,
  controlType?: string,
  /** (H3) When hwnd is provided, bypass title-based root search (fixes Save As / common dialogs). */
  options?: { hwnd?: bigint }
): Promise<{ ok: boolean; element?: string; error?: string; code?: string }> {
  refuseUiaTitleIfExcluded(windowTitle);
  if (options?.hwnd !== undefined) refuseUiaHwndIfExcluded(options.hwnd);
  // ADR-036 — on the WRITE path a handle is authoritative and is never traded for a title.
  //
  // The read half gates its scoping on "does the title already name only this window?", because
  // scoping every read costs a PowerShell round trip on every `desktop_discover` (184 ms against
  // 517 ms, measured) and `normalizeTarget` fills a handle from the foreground even for a bare
  // call. The same trade was written here and refused, correctly, by gate 1: the check is not
  // atomic — a same-titled window can appear between the enumeration and the invoke — and it
  // compares Win32 captions against a search that matches UIA `Name`, which is not always the
  // caption. Both ways of being wrong land in exactly the case this ADR is about, and here being
  // wrong means the click happens in the other window. A read that goes to the wrong window
  // comes back describing it; a write does not come back at all.
  //
  // So the cost stays, and it is named rather than negotiated: `uiaClickElement` takes a title
  // and nothing else, so an aimed action is a PowerShell round trip. The way out is to give the
  // native side a handle — not to make the aim conditional on an enumeration.
  //
  // H3 — this is also what reaches the common dialogs (Save As on Win11 Notepad): they are not
  // among the UIA root children the title search walks, and `FromHandle` does not walk them.
  if (options?.hwnd === undefined && nativeUia?.uiaClickElement) {
    try {
      const result = await nativeUia.uiaClickElement({
        windowTitle,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
        controlType: controlType ?? undefined,
      });
      return {
        ok: result.ok,
        element: result.element ?? undefined,
        error: result.error ?? undefined,
        code: result.code ?? undefined,
      };
    } catch (e) {
      console.warn("[uia-bridge] Native uiaClickElement failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback — use hwnd-based script when available (H3)
  const script = options?.hwnd !== undefined
    ? makeClickElementScriptByHwnd(options.hwnd, name, automationId, controlType)
    : makeClickElementScript(windowTitle, name, automationId, controlType);
  const output = await runPS(script, 8000);
  return JSON.parse(output);
}

export async function setElementValue(
  windowTitle: string,
  value: string,
  name?: string,
  automationId?: string,
  /** (H3) When hwnd is provided, bypass title-based root search (fixes Save As / common dialogs). */
  options?: { hwnd?: bigint }
): Promise<{ ok: boolean; error?: string; code?: string }> {
  refuseUiaTitleIfExcluded(windowTitle);
  if (options?.hwnd !== undefined) refuseUiaHwndIfExcluded(options.hwnd);
  // A handle is authoritative here too — see `clickElement` above for why the read half's gate
  // does not belong on a write.
  if (options?.hwnd === undefined && nativeUia?.uiaSetValue) {
    try {
      const result = await nativeUia.uiaSetValue({
        windowTitle,
        value,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
      });
      return { ok: result.ok, error: result.error ?? undefined, code: result.code ?? undefined };
    } catch (e) {
      console.warn("[uia-bridge] Native uiaSetValue failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback — use hwnd-based script when available (H3)
  const script = options?.hwnd !== undefined
    ? makeSetValueScriptByHwnd(options.hwnd, name, automationId, value)
    : makeSetValueScript(windowTitle, name, automationId, value);
  const output = await runPS(script, 8000);
  return JSON.parse(output);
}

/**
 * Set text on an element using UIA TextPattern2.InsertTextAtSelection.
 * Foreground-free — works for apps that support TextPattern2 but not ValuePattern.
 * Returns ok:false with code:"TextPattern2NotSupported" when the pattern is unavailable.
 */
export async function insertTextViaTextPattern2(
  windowTitle: string,
  value: string,
  name?: string,
  automationId?: string
): Promise<{ ok: boolean; code?: string; error?: string }> {
  refuseUiaTitleIfExcluded(windowTitle);
  // ★ Rust native path (Phase C)
  if (nativeUia?.uiaInsertText) {
    try {
      const result = await nativeUia.uiaInsertText({
        windowTitle,
        value,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
      });
      return { ok: result.ok, code: result.code ?? undefined, error: result.error ?? undefined };
    } catch (e) {
      console.warn("[uia-bridge] Native uiaInsertText failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback
  const safeTitle = escapeLike(windowTitle);
  const nameFilter = name ? `$c.Name -like '*${escapeLike(name)}*'` : "$true";
  const idFilter = automationId ? `$c.AutomationId -eq '${escapePS(automationId)}'` : "$true";
  const escaped = escapePS(value);

  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$desc  = [System.Windows.Automation.TreeScope]::Descendants

$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"ok":false,"code":"WindowNotFound"}'; exit }

$found = $null
$all = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter})) { $found = $el; break }
}
if (-not $found) { Write-Output '{"ok":false,"code":"ElementNotFound"}'; exit }

try {
    $tp2 = $null
    $patId = [System.Windows.Automation.TextPattern2]::Pattern
    $supported = $found.TryGetCurrentPattern($patId, [ref]$tp2)
    if (-not $supported -or $null -eq $tp2) {
        Write-Output '{"ok":false,"code":"TextPattern2NotSupported"}'; exit
    }
    $tp2.InsertTextAtSelection('${escaped}')
    Write-Output '{"ok":true}'
} catch {
    Write-Output '{"ok":false,"code":"TextPattern2Error"}'
}
`;
  const output = await runPS(script, 8000);
  try { return JSON.parse(output); }
  catch { return { ok: false, code: "TextPattern2ParseError", error: output.slice(0, 200) }; }
}

/**
 * Query IVirtualDesktopManager COM to determine which HWNDs are on the current virtual desktop.
 * @param hwndIntegers - Array of HWND values as decimal strings
 * @returns Map of hwndString → isOnCurrentDesktop (true if on current desktop or on error)
 */
export async function getVirtualDesktopStatus(
  hwndIntegers: string[]
): Promise<Record<string, boolean>> {
  if (hwndIntegers.length === 0) return {};

  // ★ Rust native path
  if (nativeUia?.uiaGetVirtualDesktopStatus) {
    try {
      return await nativeUia.uiaGetVirtualDesktopStatus(hwndIntegers);
    } catch (e) {
      console.warn("[uia-bridge] Native uiaGetVirtualDesktopStatus failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback
  const hwndList = hwndIntegers.join(",");
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b")]
public interface IVirtualDesktopManager {
    [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, [MarshalAs(UnmanagedType.Bool)] out bool onCurrentDesktop);
    [PreserveSig] int GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);
    [PreserveSig] int MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
}
"@
$clsid = [Guid]'aa509086-5ca9-4c25-8f95-589d3c07b48a'
$vdm = $null
try { $vdm = [Activator]::CreateInstance([Type]::GetTypeFromCLSID($clsid)) } catch {}
$result = @{}
foreach ($h in @(${hwndList})) {
    $key = "$h"
    if ($vdm -eq $null) { $result[$key] = $true; continue }
    try {
        $ptr = [IntPtr]::new([long]$h)
        $onCurrent = $false
        $hr = $vdm.IsWindowOnCurrentVirtualDesktop($ptr, [ref]$onCurrent)
        $result[$key] = ($hr -eq 0 -and $onCurrent)
    } catch { $result[$key] = $true }
}
$result | ConvertTo-Json -Compress
`;

  try {
    const output = await runPS(script, 5000);
    const parsed = JSON.parse(output);
    // PowerShell may return null for empty objects
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, boolean>;
  } catch {
    // Graceful fallback: assume all windows are on current desktop
    const fallback: Record<string, boolean> = {};
    for (const h of hwndIntegers) fallback[h] = true;
    return fallback;
  }
}

export interface ElementBounds {
  name: string;
  controlType: string;
  automationId: string;
  boundingRect: { x: number; y: number; width: number; height: number } | null;
  value: string | null;
}

/**
 * Get the UI element subtree rooted at a specific element (not the whole window tree).
 * Used by scope_element to return children of only the matched element.
 */
function makeGetChildrenScript(
  windowTitle: string,
  name: string | undefined,
  automationId: string | undefined,
  controlType: string | undefined,
  maxDepth: number,
  maxElements: number
): string {
  const safeTitle = escapeLike(windowTitle);
  const nameFilter = name ? `$c.Name -like '*${escapeLike(name)}*'` : "$true";
  const idFilter = automationId ? `$c.AutomationId -eq '${escapePS(automationId)}'` : "$true";
  const typeFilter = controlType
    ? `$c.ControlType.ProgrammaticName -like '*${escapeLike(controlType)}*'`
    : "$true";

  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root   = [System.Windows.Automation.AutomationElement]::RootElement
$trueC  = [System.Windows.Automation.Condition]::TrueCondition
$desc   = [System.Windows.Automation.TreeScope]::Descendants

$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"error":"Window not found"}'; exit }

$found = $null
function FindElement($el, $depth) {
    if ($script:found) { return }
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter}) -and (${typeFilter})) { $script:found = $el; return }
    if ($depth -gt 12) { return }
    $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
    foreach ($k in $kids) { FindElement $k ($depth+1) }
}
FindElement $target 0
if (-not $found) { Write-Output '{"error":"Element not found"}'; exit }

$results = [System.Collections.Generic.List[object]]::new()
$count = 0

function Collect($el, $depth) {
    if ($depth -gt ${maxDepth} -or $script:count -ge ${maxElements}) { return }
    $c = $el.Current
    $r = $c.BoundingRectangle
    $rect = $null
    if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) {
        $rect = @{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height }
    }
    $pats = @($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'Identifiers\\.Pattern','' })
    $script:results.Add(@{
        name=$c.Name; controlType=($c.ControlType.ProgrammaticName -replace 'ControlType\\.','')
        automationId=$c.AutomationId; isEnabled=$c.IsEnabled
        boundingRect=$rect; patterns=$pats; depth=$depth
    })
    $script:count++
    $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
    foreach ($k in $kids) { Collect $k ($depth+1) }
}

# Start traversal from the matched element (not the window root)
$kids = $found.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($k in $kids) { Collect $k 0 }

@{ elementCount=$results.Count; elements=$results.ToArray() } | ConvertTo-Json -Depth 6 -Compress
`;
}

export async function getElementChildren(
  windowTitle: string,
  name: string | undefined,
  automationId: string | undefined,
  controlType: string | undefined,
  maxDepth = 2,
  maxElements = 30,
  timeoutMs = 5000
): Promise<UiElement[]> {
  refuseUiaTitleIfExcluded(windowTitle);
  // ★ Rust native path (Phase C)
  if (nativeUia?.uiaGetElementChildren) {
    try {
      const result = await nativeUia.uiaGetElementChildren({
        windowTitle,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
        controlType: controlType ?? undefined,
        maxDepth,
        maxElements,
        timeoutMs,
      });
      // Normalise boundingRect: Rust Option → null
      return result.map((el: NativeUiElement) => ({ ...el, boundingRect: el.boundingRect ?? null }));
    } catch (e) {
      console.warn("[uia-bridge] Native uiaGetElementChildren failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback
  const script = makeGetChildrenScript(windowTitle, name, automationId, controlType, maxDepth, maxElements);
  const output = await runPS(script, timeoutMs);
  const result = JSON.parse(output);
  if (result.error) throw new Error(result.error);
  return (result.elements ?? []) as UiElement[];
}

/**
 * Extract terminal text content via UIA TextPattern.
 * Works for Windows Terminal / conhost / PowerShell ISE windows that
 * implement TextPattern (most modern terminal hosts do).
 *
 * Returns the full visible buffer text, or null if TextPattern is unavailable.
 */
export async function getTextViaTextPattern(
  windowTitle: string,
  timeoutMs = 6000,
  /** ADR-036 — scope the read to a resolved window, so the buffer read matches the window written. */
  options?: { pinnedHwnd?: bigint },
): Promise<string | null> {
  refuseUiaTitleIfExcluded(windowTitle);
  if (options?.pinnedHwnd !== undefined) refuseUiaHwndIfExcluded(options.pinnedHwnd);
  // Scoped whenever a handle is in hand, as in `getUiElements`.
  const scopeHwnd = options?.pinnedHwnd;
  // ★ Rust native path (Phase C) — skipped while a handle is in hand: it takes a title only,
  // and a terminal buffer read from one window while the keys go to its same-titled twin is
  // the same split this ADR closed on the UIA route.
  if (nativeUia?.uiaGetTextViaTextPattern && scopeHwnd === undefined) {
    try {
      return await nativeUia.uiaGetTextViaTextPattern({ windowTitle, timeoutMs });
    } catch (e) {
      console.warn("[uia-bridge] Native uiaGetTextViaTextPattern failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback
  const safeTitle = escapeLike(windowTitle);
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$desc  = [System.Windows.Automation.TreeScope]::Descendants

${scopeHwnd !== undefined
  ? `# ADR-036: named by handle, so no title search happens here. FromHandle throws for a
# window that has gone; see the twin in makeGetElementsScript.
$hwndPtr = [System.IntPtr]::new(${scopeHwnd.toString()})
try { $target = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr) }
catch { Write-Output '{"ok":false,"error":"Window not found by hwnd"}'; exit }
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found by hwnd"}'; exit }`
  : `$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found"}'; exit }`}

# Collect ALL descendants with TextPattern, score by control-type preference
# (Document/Custom/Edit favored — these host the real terminal buffer) and
# fall back to the largest GetText payload. A naive "first match" picks the
# tab-title label in Windows Terminal and returns one line.
#
# F4-bis (c)-light: only score>0 control types qualify as candidates.
# Win11 New Notepad's auxiliary descendants (TitleBar / MenuBar / MenuItem /
# Button / etc.) implement TextPattern but score 0, and previously polluted
# the candidate set — making getTextViaTextPattern return non-null junk
# text from unrelated controls and preventing the Phase 7 ValuePattern
# fallback gate from firing. Custom (score 2) is preserved so WT/conhost
# Custom-typed pane descendants still qualify (regression guard).
function ControlTypeScore($ct) {
    switch -Regex ($ct) {
        '^(Document|Edit)$' { return 3 }
        '^Custom$'          { return 2 }
        '^(Pane|Group)$'    { return 1 }
        default             { return 0 }
    }
}

$candidates = [System.Collections.Generic.List[object]]::new()
$all = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    try {
        $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if ($null -ne $tp) {
            $ctName = ''
            try { $ctName = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\\.','' } catch {}
            if ((ControlTypeScore $ctName) -gt 0) {
                $candidates.Add(@{ tp=$tp; controlType=$ctName })
            }
        }
    } catch {}
}
# Also consider the root window itself, but only when no scored descendant
# qualified — the root is typically Window-typed (score 0) and would otherwise
# fail the (c)-light score>0 filter applied above. Score-0 root is **intentionally**
# accepted as a last-resort fallback when no scored descendant exists: this preserves
# the degenerate-case path (e.g. Edit hosted directly as toplevel) while avoiding
# root-vs-descendant noise where the root has no input echo. The score>0 filter
# above does NOT apply here because we explicitly want the Window-typed root in
# the empty-candidates case; otherwise getTextViaTextPattern would return null
# even when the toplevel itself exposes TextPattern.
try {
    $rootTp = $target.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -ne $rootTp -and $candidates.Count -eq 0) {
        $candidates.Add(@{ tp=$rootTp; controlType='Window' })
    }
} catch {}

if ($candidates.Count -eq 0) { Write-Output '{"ok":false,"error":"TextPattern not available"}'; exit }

$best = $null
$bestScore = -1
$bestLen = -1
$bestText = ''
foreach ($c in $candidates) {
    $txt = ''
    try { $txt = $c.tp.DocumentRange.GetText(-1) } catch { continue }
    if ($null -eq $txt) { $txt = '' }
    $score = ControlTypeScore $c.controlType
    # Prefer higher ControlType score; tie-break by longer text.
    if ($score -gt $bestScore -or ($score -eq $bestScore -and $txt.Length -gt $bestLen)) {
        $bestScore = $score
        $bestLen   = $txt.Length
        $bestText  = $txt
        $best      = $c
    }
    # Short-circuit: Document/Edit (score=3) with non-empty text is the best
    # we can hope for; skip GetText() on remaining candidates to save time.
    if ($bestScore -eq 3 -and $bestLen -gt 0) { break }
}

if ($null -eq $best) { Write-Output '{"ok":false,"error":"TextPattern not available"}'; exit }

try {
    $payload = @{ ok=$true; text=$bestText; controlType=$best.controlType } | ConvertTo-Json -Compress
    Write-Output $payload
} catch {
    Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  try {
    // The deadline is the read's, not the process start's — see `psReadWaitMs`.
    const out = await runPS(script, psReadWaitMs(timeoutMs));
    const parsed = JSON.parse(out) as { ok: boolean; text?: string; error?: string };
    if (!parsed.ok) return null;
    return parsed.text ?? "";
  } catch {
    return null;
  }
}

/**
 * Read the focused element's ValuePattern.Value.
 *
 * Phase 7 F4 fallback for `getTextViaTextPattern` (Phase 6 dogfood F4):
 * Win11 New Notepad's RichEditD2DPT control implements ValuePattern but
 * not TextPattern, so the existing TextPattern read-back returns
 * `unverifiable / read_back_unsupported` even though delivery actually
 * succeeded. ValuePattern is supported by Edit / RichEdit / TextBox /
 * standard Win32 input controls, complementing TextPattern coverage.
 *
 * Returns the focused element's `ValuePattern.Value` string, or null
 * when:
 * - The window cannot be located by title
 * - No focused element exists
 * - The focused element lives outside the target window's toplevel HWND
 *   (focus moved away — caller should rely on FocusLostDuringType detection)
 * - The focused element does not implement ValuePattern
 *
 * Targets the FOCUSED element specifically because BG WM_CHAR injection
 * delivers WM_CHAR to the focused HWND/element (matrix doc §3.1 line 140
 * + §4.2 verifyDelivery 規範). The TreeWalker scoping guards against
 * reading an unrelated app's value when focus is elsewhere.
 *
 * Best-effort caveat (Phase 7 F4 P2-2): focus race during the read is not
 * detected. If the focus moves away → reads → moves back during the
 * `runPS` round-trip, the Value returned is whichever element was focused
 * at the instant `vp.Current.Value` evaluated. Callers (keyboard.ts BG
 * type path) compose this with a post-injection comparison, so a transient
 * focus race produces an `unverifiable` hint rather than a false delivered.
 */
export async function getTextViaValuePattern(windowTitle: string, timeoutMs = 6000): Promise<string | null> {
  refuseUiaTitleIfExcluded(windowTitle);
  const safeTitle = escapeLike(windowTitle);
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition

# Find the target toplevel window by title substring.
$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found"}'; exit }

# Get the system focused element. If none, nothing to read back.
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if (-not $focused) { Write-Output '{"ok":false,"error":"No focused element"}'; exit }

# Walk up from focused via ControlViewWalker, recording the last non-zero
# NativeWindowHandle — this is the toplevel HWND of the focused element.
# Compare against $target.NativeWindowHandle so we only read back when the
# focused element belongs to our target window (defends against reading an
# unrelated app's ValuePattern when focus moved during BG injection).
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$probe = $focused
$focusedTopHwnd = 0
$guard = 0
while ($probe -and $guard -lt 64) {
    $hwnd = $probe.Current.NativeWindowHandle
    if ($hwnd -ne 0 -and $null -ne $hwnd) { $focusedTopHwnd = $hwnd }
    $probe = $walker.GetParent($probe)
    $guard = $guard + 1
}
$targetHwnd = $target.Current.NativeWindowHandle
if ($focusedTopHwnd -ne $targetHwnd) {
    Write-Output '{"ok":false,"error":"Focused element outside target window"}'; exit
}

# Try ValuePattern on the focused element. Edit / RichEdit / TextBox
# typically support this; complex hosts that only expose TextPattern
# (e.g. console buffers) will fail here and the caller falls back.
try {
    $vp = $focused.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -eq $vp) { Write-Output '{"ok":false,"error":"ValuePattern not available"}'; exit }
    $val = $vp.Current.Value
    if ($null -eq $val) { $val = '' }
    $payload = @{ ok=$true; text=$val } | ConvertTo-Json -Compress
    Write-Output $payload
} catch {
    # Phase 7 F4 P2-4 (Round 1 review): normalize CR/LF in the exception
    # message before splicing into a JSON string literal. Multi-line
    # InvalidOperationException messages (e.g. disposed AutomationElement)
    # would otherwise emit raw newlines into the JSON body and break
    # JSON.parse on the TS side, masking the real error as a generic null.
    $msg = $_.Exception.Message -replace '"','\\"' -replace "[\r\n]+",' '
    Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}
`;
  try {
    const out = await runPS(script, timeoutMs);
    const parsed = JSON.parse(out) as { ok: boolean; text?: string; error?: string };
    if (!parsed.ok) return null;
    return parsed.text ?? "";
  } catch {
    return null;
  }
}

/**
 * Find a UI element and return its bounding rectangle + basic properties.
 * Used by scope_element to know which screen region to screenshot.
 */
export async function getElementBounds(
  windowTitle: string,
  name?: string,
  automationId?: string,
  controlType?: string
): Promise<ElementBounds | null> {
  refuseUiaTitleIfExcluded(windowTitle);
  // ★ Rust native path (Phase C)
  if (nativeUia?.uiaGetElementBounds) {
    try {
      const result = await nativeUia.uiaGetElementBounds({
        windowTitle,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
        controlType: controlType ?? undefined,
      });
      if (!result) return null;
      return {
        name: result.name,
        controlType: result.controlType,
        automationId: result.automationId,
        boundingRect: result.boundingRect ?? null,
        value: result.value ?? null,
      };
    } catch (e) {
      console.warn("[uia-bridge] Native uiaGetElementBounds failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback
  const safeTitle = escapeLike(windowTitle);
  const nameFilter = name ? `$c.Name -like '*${escapeLike(name)}*'` : "$true";
  const idFilter = automationId ? `$c.AutomationId -eq '${escapePS(automationId)}'` : "$true";
  const typeFilter = controlType
    ? `$c.ControlType.ProgrammaticName -like '*${escapeLike(controlType)}*'`
    : "$true";

  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$desc  = [System.Windows.Automation.TreeScope]::Descendants

$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"error":"Window not found"}'; exit }

$found = $null
function FindElement($el, $depth) {
    if ($script:found) { return }
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter}) -and (${typeFilter})) { $script:found = $el; return }
    if ($depth -gt 12) { return }
    $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
    foreach ($k in $kids) { FindElement $k ($depth+1) }
}
FindElement $target 0
if (-not $found) { Write-Output '{"error":"Element not found"}'; exit }

$c = $found.Current
$r = $c.BoundingRectangle
$rect = $null
if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) {
    $rect = @{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height }
}
$value = $null
try {
    $vp = $found.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value = $vp.Current.Value
} catch {}
@{
    name=$c.Name
    controlType=($c.ControlType.ProgrammaticName -replace 'ControlType\\.','')
    automationId=$c.AutomationId
    boundingRect=$rect
    value=$value
} | ConvertTo-Json -Compress
`;

  try {
    const output = await runPS(script, 8000);
    const parsed = JSON.parse(output);
    if (parsed.error) return null;
    return parsed as ElementBounds;
  } catch {
    return null;
  }
}

/**
 * Scroll a UIA element into view using ScrollItemPattern.ScrollIntoView().
 * Falls back to a no-op (returns false) when the element does not expose ScrollItemPattern.
 */
export async function scrollElementIntoView(
  windowTitle: string,
  name?: string,
  automationId?: string,
): Promise<{ ok: boolean; scrolled: boolean; error?: string }> {
  refuseUiaTitleIfExcluded(windowTitle);
  // ★ Rust native path
  if (nativeUia?.uiaScrollIntoView) {
    try {
      const result = await nativeUia.uiaScrollIntoView({
        windowTitle,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
      });
      return { ok: result.ok, scrolled: result.scrolled, error: result.error ?? undefined };
    } catch (e) {
      console.warn("[uia-bridge] Native uiaScrollIntoView failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback
  const safeTitle = escapeLike(windowTitle);
  const nameFilter = name ? `$c.Name -like '*${escapeLike(name)}*'` : "$true";
  const idFilter = automationId ? `$c.AutomationId -eq '${escapePS(automationId)}'` : "$true";

  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition

$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"ok":false,"scrolled":false,"error":"Window not found"}'; exit }

$found = $null
function FindElement($el, $depth) {
    if ($script:found) { return }
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter})) { $script:found = $el; return }
    if ($depth -gt 12) { return }
    $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
    foreach ($k in $kids) { FindElement $k ($depth+1) }
}
FindElement $target 0
if (-not $script:found) { Write-Output '{"ok":false,"scrolled":false,"error":"Element not found"}'; exit }

try {
    $sip = $script:found.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
    $sip.ScrollIntoView()
    Write-Output '{"ok":true,"scrolled":true}'
} catch {
    Write-Output '{"ok":true,"scrolled":false,"error":"ScrollItemPattern not available"}'
}
`;

  try {
    const output = await runPS(script, 8000);
    return JSON.parse(output) as { ok: boolean; scrolled: boolean; error?: string };
  } catch (err) {
    return { ok: false, scrolled: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SmartScroll — UIA ancestor walk + ScrollPattern control
// ─────────────────────────────────────────────────────────────────────────────

export interface UiaScrollAncestor {
  name: string;
  automationId: string;
  controlType: string;
  verticalPercent: number;
  horizontalPercent: number;
  verticallyScrollable: boolean;
  horizontallyScrollable: boolean;
}

/**
 * Walk the UIA tree from the named element upward, collecting all ancestors
 * that expose ScrollPattern. Returns them ordered outer → inner.
 */
export async function getScrollAncestors(
  windowTitle: string,
  elementName: string
): Promise<UiaScrollAncestor[]> {
  refuseUiaTitleIfExcluded(windowTitle);
  // ★ Rust native path
  if (nativeUia?.uiaGetScrollAncestors) {
    try {
      const result = await nativeUia.uiaGetScrollAncestors({
        windowTitle,
        elementName,
      });
      // Rust returns controlType without "ControlType." prefix — same as TS
      return result;
    } catch (e) {
      console.warn("[uia-bridge] Native uiaGetScrollAncestors failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback
  const safeTitle = escapeLike(windowTitle);
  const safeName = escapeLike(elementName);

  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$ScrollPat = [System.Windows.Automation.ScrollPattern]::Pattern

$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found","ancestors":[]}'; exit }

$found = $null
function FindElement($el, $depth) {
    if ($script:found) { return }
    $c = $el.Current
    if ($c.Name -like '*${safeName}*') { $script:found = $el; return }
    if ($depth -gt 14) { return }
    $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
    foreach ($k in $kids) { FindElement $k ($depth+1) }
}
FindElement $target 0

$ancestors = @()
if ($script:found) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $cur = $walker.GetParent($script:found)
    while ($cur -and $cur -ne $root) {
        try {
            $sp = $cur.GetCurrentPattern($ScrollPat)
            $sv = $sp.Current
            $ancestors += @{
                name = $cur.Current.Name
                automationId = $cur.Current.AutomationId
                controlType = $cur.Current.ControlType.ProgrammaticName
                verticalPercent = $sv.VerticalScrollPercent
                horizontalPercent = $sv.HorizontalScrollPercent
                verticallyScrollable = $sv.VerticallyScrollable
                horizontallyScrollable = $sv.HorizontallyScrollable
            }
        } catch { }
        $cur = $walker.GetParent($cur)
    }
}

# Reverse to outer→inner
[array]::Reverse($ancestors)
$json = $ancestors | ConvertTo-Json -Compress -Depth 3
if (-not $json) { $json = '[]' }
# Ensure array (ConvertTo-Json emits object when count=1)
if ($json -notmatch '^\\[') { $json = "[$json]" }
Write-Output "{""ok"":true,""ancestors"":$json}"
`;

  try {
    const output = await runPS(script, 10000);
    const result = JSON.parse(output) as { ok: boolean; error?: string; ancestors: UiaScrollAncestor[] };
    return result.ancestors ?? [];
  } catch {
    return [];
  }
}

/**
 * Scroll a UIA element's ScrollPattern ancestor to a given percentage.
 * Pass -1 for either axis to leave it unchanged (UIA NoScroll).
 */
export async function scrollByPercent(
  windowTitle: string,
  elementName: string,
  verticalPercent: number,
  horizontalPercent: number
): Promise<{ ok: boolean; scrolled: boolean; error?: string }> {
  refuseUiaTitleIfExcluded(windowTitle);
  // ★ Rust native path
  if (nativeUia?.uiaScrollByPercent) {
    try {
      const result = await nativeUia.uiaScrollByPercent({
        windowTitle,
        elementName,
        verticalPercent,
        horizontalPercent,
      });
      return { ok: result.ok, scrolled: result.scrolled, error: result.error ?? undefined };
    } catch (e) {
      console.warn("[uia-bridge] Native uiaScrollByPercent failed, falling back to PowerShell:", e);
    }
  }

  // PowerShell fallback
  const safeTitle = escapeLike(windowTitle);
  const safeName = escapeLike(elementName);
  const vp = verticalPercent < 0 ? -1 : Math.max(0, Math.min(100, Math.round(verticalPercent)));
  const hp = horizontalPercent < 0 ? -1 : Math.max(0, Math.min(100, Math.round(horizontalPercent)));

  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$ScrollPat = [System.Windows.Automation.ScrollPattern]::Pattern

$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"ok":false,"scrolled":false,"error":"Window not found"}'; exit }

$found = $null
function FindElement($el, $depth) {
    if ($script:found) { return }
    if ($el.Current.Name -like '*${safeName}*') { $script:found = $el; return }
    if ($depth -gt 14) { return }
    $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
    foreach ($k in $kids) { FindElement $k ($depth+1) }
}
FindElement $target 0
if (-not $script:found) { Write-Output '{"ok":false,"scrolled":false,"error":"Element not found"}'; exit }

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$cur = $walker.GetParent($script:found)
$sp = $null
while ($cur -and $cur -ne $root) {
    try { $sp = $cur.GetCurrentPattern($ScrollPat); break } catch { }
    $cur = $walker.GetParent($cur)
}
if (-not $sp) { Write-Output '{"ok":false,"scrolled":false,"error":"No ScrollPattern ancestor found"}'; exit }

try {
    $sp.SetScrollPercent(${hp}, ${vp})
    Write-Output '{"ok":true,"scrolled":true}'
} catch {
    Write-Output "{""ok"":false,""scrolled"":false,""error"":""$($_.Exception.Message)""}"
}
`;

  try {
    const output = await runPS(script, 8000);
    return JSON.parse(output) as { ok: boolean; scrolled: boolean; error?: string };
  } catch (err) {
    return { ok: false, scrolled: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UIA-Blind detection (Step 1 of Hybrid Non-CDP pipeline)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reason why a window is considered "UIA-Blind".
 * - "too-few-elements"  : total element count is below the sparse threshold
 * - "single-giant-pane" : a single Pane covers ≥90% of the window area,
 *                         suggesting a non-accessible renderer (game, RDP, etc.)
 */
export type UiaBlindReason = "too-few-elements" | "single-giant-pane";

/** Minimum element count below which the window is considered UIA-Blind. */
const UIA_BLIND_MIN_ELEMENTS = 5;

/** Area ratio threshold above which a single Pane triggers UIA-Blind. */
const UIA_BLIND_PANE_AREA_RATIO = 0.9;

/**
 * Inspect a `UiElementsResult` and determine whether the window is "UIA-Blind"
 * (i.e. UIA tree is too sparse to be useful — likely a game, RDP session, or
 * app using a custom non-accessible renderer).
 *
 * Pure function — does not perform any async I/O.
 *
 * @returns `{ blind: false }` when the UIA tree looks healthy.
 *          `{ blind: true, reason }` when the Sparsity conditions are met.
 */
export function detectUiaBlind(
  result: UiElementsResult,
): { blind: false } | { blind: true; reason: UiaBlindReason } {
  // Condition A: total element count is critically low
  if (result.elementCount < UIA_BLIND_MIN_ELEMENTS) {
    return { blind: true, reason: "too-few-elements" };
  }

  // Condition B: a single Pane dominates the entire window area
  const wr = result.windowRect;
  if (wr != null) {
    const windowArea = wr.width * wr.height;
    if (windowArea > 0) {
      const giantPane = result.elements.find((el) => {
        if (el.controlType !== "Pane") return false;
        const r = el.boundingRect;
        if (!r || r.width <= 0 || r.height <= 0) return false;
        return (r.width * r.height) / windowArea >= UIA_BLIND_PANE_AREA_RATIO;
      });

      if (giantPane) {
        // Allow up to 4 other actionable elements before we accept the tree as valid.
        // This prevents false positives on apps that wrap everything in one Pane
        // but still expose buttons/edits inside it.
        const otherActionable = result.elements.filter(
          (el) =>
            el !== giantPane &&
            el.boundingRect != null &&
            el.boundingRect.width >= 4 &&
            el.boundingRect.height >= 4 &&
            el.controlType !== "Pane" &&
            el.controlType !== "Window",
        );

        if (otherActionable.length < UIA_BLIND_MIN_ELEMENTS) {
          return { blind: true, reason: "single-giant-pane" };
        }
      }
    }
  }

  return { blind: false };
}
