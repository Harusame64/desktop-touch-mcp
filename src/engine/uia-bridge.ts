import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCachedUia, updateUiaCache } from "./layer-buffer.js";
import { AIM_WINDOW_GONE, AimedWindowGoneError } from "./aim.js";
import { computeViewportPosition } from "../utils/viewport-position.js";
import { nativeUia, type NativeUiElement } from "./native-engine.js";
import { isExcludedTitle, isExcludedWindowHandle, isWindowGone } from "./win32.js";
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
 * (R3 tool-exclusion) The by-handle route (`options.pinnedHwnd` on the reads, `options.hwnd` on
 * the writes) skips the title-based root search, so the title check above no longer stands
 * between a caller and the window it names. A caller holding
 * the locker's handle — or one that resolved it before the locker armed — would otherwise reach
 * the secure dialog with any benign title string attached. The handle registry is the same one
 * `enumWindowsInZOrder` consults, and it short-circuits to `false` when no locker is alive.
 */
function refuseUiaHwndIfExcluded(hwnd: bigint): void {
  if (!isExcludedWindowHandle(hwnd)) return;
  // ADR-036 — that predicate fails CLOSED on a PID it cannot read, and a window that has been
  // destroyed reads as PID 0. So while a locker is armed, an ordinary closed window came back as
  // a security refusal: the executor rethrows `WindowExcludedError` without trying anything else
  // and the caller is told it may not touch a window that no longer exists, instead of being
  // told to discover again (2ゲート目の指摘). Both answers refuse; only one of them is true.
  if (isWindowGone(hwnd)) throw new AimedWindowGoneError(hwnd);
  throw new WindowExcludedError(
    `UIA target window handle ${hwnd} belongs to the desktop-touch key locker and is excluded`,
  );
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
 * How long a PowerShell read may spend before its own work starts: process start plus two
 * `Add-Type` assembly loads.
 *
 * Measured on the Windows machine 2026-09-09 (`dev/ps-startup-20260909/`): **233 ms median** for
 * `powershell.exe` 5.1 with both loads, 190.9 ms for the bare start, and 814 ms median / 1044 ms
 * worst with sixteen spawning at once. **A cold machine was not measured**, so this stays the
 * generous number it always was — but only where being generous is free.
 *
 * Where it is free: the WAIT around a read that has no clock of its own (`psReadWaitMs`). A
 * timeout that is too long costs nothing until something has already failed.
 *
 * Where it was not free: the walk's budget, which used to be `deadline - this`. At 4000 against a
 * real 233 the walk lost seconds it could have used, and `_narration.ts`'s 4000 ms deadline
 * collapsed to the floor — so its two snapshots truncated at different points and the diff
 * reported elements appearing and disappearing that never moved (2ゲート目の指摘). The script
 * measures its own start now (see `makeGetElementsScript`), so no estimate stands between the
 * caller's deadline and the walk.
 */
const PS_STARTUP_HEADROOM_MS = 4000;
/** Enough to reach a first element and print. Below this the walk is not worth starting. */
const PS_MIN_TREE_BUDGET_MS = 1000;
/**
 * Left at the end of the deadline for `ConvertTo-Json -Depth 6` and the write to stdout.
 *
 * Set by which way being wrong hurts. Too small and the serialise overruns the wait that kills
 * the process: empty stdout, a parse error, **the whole read lost**, which is the failure
 * `truncated` exists to replace with a partial answer. Too large and the walk gives up time it
 * could have spent, and says so in `truncated`. One of those is recoverable by the caller and
 * the other is not, so this is generous rather than tight (2ゲート目の指摘: at 300 ms it was
 * neither, on a path this branch had just made the primary one).
 *
 * Since measured, and generous by more than it needed to be: `ConvertTo-Json -Depth 6 -Compress`
 * plus the stdout write took **55.4 ms for an empty tree and 56.0 ms for 120 elements**, 75.8 ms
 * at the worst of a synthetic thousand — it is almost all fixed cost, the first use of the
 * cmdlet in the process (a second serialise in the same process is under 1 ms). So 1000 is about
 * thirteen times the worst case, and the reason to leave it there is that nothing is asking for
 * the difference: what binds this path is the deadline and the process start, not the margin
 * (win, 2026-09-09, `dev/ps-startup-20260909/`).
 */
const PS_PRINT_MARGIN_MS = 1000;

/**
 * ADR-036 — there used to be a `psTreeBudgetMs(deadline)` here, deriving the walk's budget by
 * subtracting `PS_STARTUP_HEADROOM_MS` from the caller's deadline. It answered a real defect —
 * budget and wait were both a fixed 8000, so a walk that used its budget was killed before it
 * could print — and then the estimate it leaned on turned out to be seventeen times the measured
 * value, which cost `_narration.ts` most of its walking time. The script measures its own start
 * instead; see `psBudgetExpression`.
 */

/**
 * The PowerShell lines the walk uses to work out its own budget: the caller's deadline, less what
 * starting up actually took, less room to print.
 *
 * `spawnedAtMs` is read here, one statement before the process is created; the script reads the
 * same clock after its assemblies are loaded and its target window is found. **The same clock is
 * the whole contract**: both sides read UTC wall time, and swapping either half for a monotonic
 * one (`process.hrtime.bigint()` here, `Stopwatch::GetTimestamp()` there) breaks it *silently* —
 * the subtraction would come out as the machine's uptime and the budget would land on the floor
 * for every call, with nothing thrown to say so (win, 2026-09-09, who checked the pairing on the
 * real machine and left `dev/ps-startup-20260909/verify-node-clock.mjs` for the next person to
 * change one side). What the subtraction gives is the startup this machine really had, on this
 * run, under whatever load it was under — which is what `PS_STARTUP_HEADROOM_MS` was guessing at.
 *
 * Both sides read UTC, and both must: `[datetime]::Now` in the script would be out by the
 * machine's offset from UTC, which is nine hours of budget on the machine this was checked on,
 * and again nothing would be thrown. The whole expression was run there — JST, `ja-JP` — and
 * came back at 233 ms median, overlapping the arms measured other ways
 * (`dev/ps-startup-20260909/verify-wallclock-pair.mjs`, which carries the values that would give
 * a wrong clock away).
 *
 * Resolution does not threaten this. `[datetime]::UtcNow` was measured at 1.001 ms median on
 * 5.1 and `Date.now()` at 1 ms; the familiar 15.6 ms is the OS's default timer tick and applies
 * only when nothing has raised it, so even at its worst it is under 7% of a 233 ms startup.
 *
 * A clock that steps FORWARDS shortens the budget to nothing, which is safe and is where sleep
 * and resume land. One that steps BACKWARDS would have lengthened it — past the deadline — until
 * the inner clamp below; the sentence that used to sit here said the opposite (win, 2026-09-09,
 * who ran the expression rather than reading it).
 */
function psBudgetExpression(deadlineMs: number, spawnedAtMs: number): string {
  // Epoch milliseconds by subtraction rather than `[DateTimeOffset]::…ToUnixTimeMilliseconds()`,
  // which needs .NET 4.6. This form works on every framework `powershell.exe` 5.1 can be sitting
  // on, and a script that throws here would come back as empty stdout and a parse error — the
  // failure this file has already spent two rounds removing.
  //
  // The epoch is CONSTRUCTED, and the point is that nothing here parses a date at all.
  //
  // Not because the cast was broken: `[datetime]'1970-01-01'` was measured across eight cultures
  // including three non-Gregorian calendars, as a literal, through a variable, and through
  // `Invoke-Expression`, and every one agreed — PowerShell converts strings to `datetime`
  // invariantly, unlike C#'s `Parse` (win, 2026-09-09, `dev/ps-startup-20260909/`). What was
  // measured to be dangerous is `[datetime]::Parse($s)`: +543 years in `th-TH`, negative in
  // `fa-IR`, and an EXCEPTION in `ar-SA` — which arrives here as empty stdout and a JSON parse
  // error, the same shape as the .NET 4.6 method this expression already avoids.
  //
  // So this guards a rewrite rather than a bug: while a date string is sitting in the
  // expression, someone tidying it can reach for `::Parse` and land on that. There is no string.
  // The test that asserts the literal is absent is the same guard from the other side.
  const nowMs = "[int64]([datetime]::UtcNow - [datetime]::new(1970,1,1)).TotalMilliseconds";
  // Floored at zero, not at a minimum walk. A floor above what is left would put the walk past
  // the wait that kills the process — `workspace.ts` asks for 2000 ms, and a slow start plus a
  // 1000 ms floor ends at ~2044 ms against a 2000 ms kill, so the caller gets empty stdout and a
  // parse error: the whole read lost, which is the failure `truncated` exists to avoid
  // (2ゲート目の指摘). A walk with no time left prints an empty tree that says it was cut short,
  // which is a thing a caller can act on.
  // A clock that steps BACKWARDS between the timestamp taken here and the read inside the script
  // makes the elapsed term negative, and a negative subtrahend LENGTHENS the budget — past the
  // deadline, so the walk outlives `runPS`'s kill and the read is lost entirely. Measured by
  // running the emitted expression rather than reading it: a 2 s backwards step against a
  // 2000 ms deadline gave a 2909 ms budget and a 4142 ms walk (win, 2026-09-09).
  //
  // Clamping that term at zero fixes the sign but throws the startup out of the sum with it: the
  // script would then believe it started instantly and walk `deadline − margin`, on top of a
  // start that really happened, overshooting the kill by `startup + print − margin`. Smaller,
  // same shape. So a nonsense measurement falls back to the estimate instead of to zero —
  // `PS_STARTUP_HEADROOM_MS` is generous (measured 233 ms against 4000) and generous is the safe
  // direction here, which is the one place in this file where that constant still earns its keep.
  return [
    `$elapsedMs = ${nowMs} - ${spawnedAtMs}`,
    `if ($elapsedMs -lt 0) { $elapsedMs = ${PS_STARTUP_HEADROOM_MS} }`,
    `$budgetMs = [Math]::Max(0, ${deadlineMs} - $elapsedMs - ${PS_PRINT_MARGIN_MS})`,
  ].join("\n");
}

/**
 * ADR-036 — how long to wait on a script that has no clock of its own.
 *
 * For the other shape of read. The tree walk carries a stopwatch and stops itself inside the
 * caller's deadline; the TextPattern read is a single `FindAll(Descendants)` followed by
 * `GetText`, and neither can be interrupted, so nothing inside that script can be shortened.
 * What moves instead is the wait — and a wait that is too long costs nothing until something has
 * already failed, which is why the generous constant lives here and nowhere else.
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
  /** The caller's whole deadline. The script works out how much of it is left — see
   * `psBudgetExpression`. */
  deadlineMs: number = PS_MIN_TREE_BUDGET_MS + PS_PRINT_MARGIN_MS,
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
# Guarded for the same reason FromHandle is: a window closing between two calls on the same
# handle is routine, and reading .Current throws ElementNotAvailableException when it does. Left
# outside, that ended the script with a PowerShell error record — an exec/parse failure where the
# catch above was added to print one sentence (2ゲート目の指摘).
try {
    $winTitle     = $target.Current.Name
    $winClassName = $target.Current.ClassName
} catch { Write-Output '{"error":"Window not found by hwnd"}'; exit }

# ADR-036 item 15 — WHICH window this read resolved. Read from the element that was actually
# walked, never by asking the title again: the second ask can land on a different window, and a
# result that names the wrong window is worse than one that names none.
#
# Its own try, and not folded into the one above: a window that cannot report its handle still has
# a title and a tree worth returning, and the caller treats an absent handle as "this read cannot
# say" — which is what every consumer did before this field existed. Zero is dropped for the same
# reason the native road drops it: "no window" and "window 0" are different facts.
#
# UNSIGNED, deliberately. NativeWindowHandle is an Int32 on the managed side, so a handle with the
# high bit set arrives NEGATIVE, and a plain [int64] cast would sign-extend it into a negative
# decimal string. parseWindowHandle rejects non-positive handles, so such a window would record no
# handle and silently keep the behaviour this item exists to end — the failure being invisible is
# what makes it worth two casts (PR 側 codex on #619, P2). Masked through Int64 first because a
# direct [uint32] cast of a negative Int32 throws in PowerShell rather than wrapping.
$winHwnd = $null
try {
    $h = $target.Current.NativeWindowHandle
    if ($h -ne 0) { $winHwnd = [string][uint32]([int64]$h -band 0xFFFFFFFF) }
} catch {}

# Capture window bounding rect for the caller
$winRect = $null
try {
    $wr = $target.Current.BoundingRectangle
    if (-not $wr.IsEmpty -and -not [double]::IsInfinity($wr.X)) {
        $winRect = @{ x=[int]$wr.X; y=[int]$wr.Y; width=[int]$wr.Width; height=[int]$wr.Height }
    }
} catch {}

# ADR-036 — the same traversal the native walker uses: FindAll(Children) under the ControlView
# condition, breadth-first, one call per parent, root children at depth 1. The two roads reach
# the same tree by construction rather than by coincidence, and they mean the same thing by
# depth.
#
# It is NOT the fix for the missing window frame, though it was written as one. A pinned read of
# Notepad returns 2 elements where the same read by title returns 26 — no title bar, no menu, no
# close button, not even the text editor — and the first explanation offered was this traversal.
# Then it was measured properly: from this client, TreeScope Children, Descendants and Subtree
# all return the same 2, the element FromHandle returns is the same element (identical
# RuntimeId) the title search finds, and the walk here reports truncated:false because it really
# has finished. What is left is the CLIENT: everything here goes through the managed
# System.Windows.Automation, and the Rust engine goes through COM IUIAutomation. Same window,
# same scope, same condition, 2 against 26.
#
# Until that is closed, a read that lands on this road sees a window's contents but not its
# frame — which inverts the ADR, because it is the read that NAMED its window that lands here.
$cvCond   = [System.Windows.Automation.Automation]::ControlViewCondition
$children = [System.Windows.Automation.TreeScope]::Children

# ADR-036 — teach this client to see the window's frame.
#
# The managed client (System.Windows.Automation) reaches a legacy window's title bar, menu bar
# and close button only through the clientside providers, which synthesise them from MSAA — and
# that assembly is registered per process. A bare powershell.exe has no registration, so a read
# of Notepad came back with the two client-area panes and nothing else: no title bar, no menu, no
# close button, not even the text editor. The COM client the Rust engine uses needs none of this,
# which is why the same window was 2 elements here and 26 there (measured 2026-09-09).
#
# ORDER MATTERS, and getting it wrong is silent. Registering straight after Add-Type does
# nothing at all — measured, four ways: no registration 2 elements, registration alone 2,
# warm-up alone 2, warm-up THEN registration 26. So the warm-up call below is not a spare RPC;
# it is what makes the next line take effect. Nothing throws in the case that does not work.
#
# So the result reports what happened, because the failure is invisible otherwise: the count
# before registering is kept, and the walk's own first level is compared against it at the end.
$preRegisterChildren = -1
try { $preRegisterChildren = $target.FindAll($children, $cvCond).Count } catch {}
$clientProviders = 'unavailable'
try {
    $regMethod = [System.Windows.Automation.ClientSettings].GetMethod('RegisterClientSideProviderAssembly')
    if ($null -ne $regMethod) {
        [System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly(
            (New-Object System.Reflection.AssemblyName(
                'UIAutomationClientsideProviders, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')))
        $clientProviders = 'registered'
    }
} catch { $clientProviders = 'failed' }
$results  = [System.Collections.Generic.List[object]]::new()
$count    = 0
# What is left of the caller's deadline now that starting up and finding the window are paid for.
${psBudgetExpression(deadlineMs, Date.now())}
$sw       = [System.Diagnostics.Stopwatch]::StartNew()

# Queue entries are (parent, depth of its children), and the root's children are depth 1 — the
# native walker's numbering, so the two roads agree on what depth means as well as on what the
# tree contains.
$queue = [System.Collections.Generic.Queue[object]]::new()
$queue.Enqueue(@{ el=$target; depth=1 })

# Patterns we care about (subset of all UIA patterns)
$wantedPats = [System.Collections.Generic.HashSet[string]]::new()
$wantedPats.Add('InvokePattern') > $null; $wantedPats.Add('ValuePattern') > $null
$wantedPats.Add('ExpandCollapsePattern') > $null; $wantedPats.Add('SelectionItemPattern') > $null
$wantedPats.Add('TogglePattern') > $null; $wantedPats.Add('ScrollPattern') > $null

:bfs while ($queue.Count -gt 0 -and $count -lt ${maxElements} -and $sw.ElapsedMilliseconds -lt $budgetMs) {
    $item   = $queue.Dequeue()
    $parent = $item.el
    $depth  = $item.depth
    if ($depth -gt ${maxDepth}) { continue }

    # One call per parent, like the native path. A parent that refuses to enumerate is skipped
    # rather than ending the walk.
    $kids = $null
    try { $kids = $parent.FindAll($children, $cvCond) } catch { continue }
    if ($null -eq $kids) { continue }

    foreach ($el in $kids) {
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
    if ($count -ge ${maxElements}) { break bfs }

    if ($depth -lt ${maxDepth}) { $queue.Enqueue(@{ el=$el; depth=($depth+1) }) }
    }
}

# ADR-036 — say when the walk ran out of time. A short deadline can still cut the tree mid-walk,
# and a truncated tree that does not admit it is worse than none: _narration diffs two snapshots,
# and two different truncation points read as elements appearing and disappearing that never
# changed (2ゲート目の指摘). Running out of maxElements is the caller's own limit, and is not this.
$truncated = ($queue.Count -gt 0) -and ($sw.ElapsedMilliseconds -ge $budgetMs)
# Did the registration above actually take? Compared by what the tree yields, not by the call
# returning without error — the case that silently does nothing also returns without error. A
# walk cut short by maxElements can under-count the first level, so this is advisory.
$firstLevel = @($results | Where-Object { $_.depth -eq 1 }).Count
if ($clientProviders -eq 'registered' -and $preRegisterChildren -ge 0 -and $firstLevel -le $preRegisterChildren) {
    $clientProviders = 'noop'
}
@{ windowTitle=$winTitle; windowClassName=$winClassName; windowHwnd=$winHwnd; windowRect=$winRect; elementCount=$results.Count; truncated=$truncated; clientProviders=$clientProviders; elements=$results.ToArray() } | ConvertTo-Json -Depth 6 -Compress
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
 * ADR-036 — the same warm-up-then-register the read does, for the scripts that WRITE.
 *
 * The registration is process-local and every call is a fresh `powershell.exe`, so a discover
 * that registered and an act that did not are two different views of the window: discover
 * returned Notepad's `Close` button and the act could not find it. Measured on Windows
 * 2026-09-09 — and what happened next is the reason this is not cosmetic. The UIA lookup missed,
 * the executor downgraded to a mouse click at the entity's stale rect, and the response came
 * back `ok:true` with the truth only in `downgrade`. On `Minimize` the rect was already
 * `-32000,-32000`. So the frame this branch made VISIBLE was only ever pressable through the
 * blind fallback this ADR exists to remove.
 *
 * The warm-up before the registration is not a spare RPC: registering first does nothing at all,
 * silently (measured four ways).
 */
const PS_REGISTER_CLIENTSIDE_PROVIDERS = `
# Guarded: this is injected between FromHandle and the walk, inside the stretch a window can
# vanish in, and a bare FindAll there threw ElementNotAvailableException straight out of the
# script — so the caller got an exec failure instead of the aim_window_gone code the surrounding
# try/catch prints (2ゲート目の指摘). A warm-up that could not run is not fatal on its own; the
# registration below is already best-effort, and the walk that follows raises the real refusal.
try { $null = $target.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Automation]::ControlViewCondition) } catch {}
try {
    $regMethod = [System.Windows.Automation.ClientSettings].GetMethod('RegisterClientSideProviderAssembly')
    if ($null -ne $regMethod) {
        [System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly(
            (New-Object System.Reflection.AssemblyName(
                'UIAutomationClientsideProviders, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')))
    }
} catch {}
`;

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
${PS_REGISTER_CLIENTSIDE_PROVIDERS}
$desc  = [System.Windows.Automation.TreeScope]::Descendants
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$found = $null
# ADR-036 — the window can go between FromHandle and the invoke, and everything in this stretch
# throws ElementNotAvailableException when it does: FindAll, $el.Current, TryGetCurrentPattern.
# Only FromHandle was caught, so a window closing here died with a PowerShell exception, reached
# the caller as a JSON parse error, and the executor read that as an ordinary UIA failure — the
# route that used to end at a blind press of the remembered rect (PR 側 codex の P1).
try {
$all   = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter}) -and (${typeFilter})) { $found = $el; break }
}
} catch { Write-Output '{"ok":false,"error":"Window not found by hwnd","code":"${AIM_WINDOW_GONE}"}'; exit }
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
# ADR-036 — the name is read BEFORE the invoke and serialised by ConvertTo-Json, not concatenated.
#
# Two failures in one line before this. A name containing a quote or a newline produced invalid
# JSON, so JSON.parse threw AFTER the invoke had already happened, and the caller saw an
# ordinary failure for an action that had succeeded. And reading $found.Current.Name after
# $ip.Invoke() throws ElementNotAvailableException for exactly the controls worth invoking —
# a Close or an OK that destroys itself — turning a success into a failure with no way to tell.
# Both ended at the same place: the executor treating it as a UIA miss (PR 側 codex の P1/P2).
$elementName = ''
try { $elementName = [string]$found.Current.Name } catch {}
try {
    $ip.Invoke()
    @{ ok = $true; element = $elementName } | ConvertTo-Json -Compress
} catch {
    @{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
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
${PS_REGISTER_CLIENTSIDE_PROVIDERS}
$desc  = [System.Windows.Automation.TreeScope]::Descendants
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$found = $null
# The same catch as the click script's — see there.
try {
$all   = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter})) { $found = $el; break }
}
} catch { Write-Output '{"ok":false,"error":"Window not found by hwnd","code":"${AIM_WINDOW_GONE}"}'; exit }
if (-not $found) { Write-Output '{"ok":false,"error":"Element not found"}'; exit }

try {
    $vp = $found.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue('${escaped}')
    Write-Output '{"ok":true}'
} catch {
    # Serialised, not concatenated — an exception message can carry a quote (see the click
    # script), and invalid JSON here reads as an ordinary failure for a write that may have
    # happened.
    @{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
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
  /**
   * ADR-036 item 15 — WHICH window this read describes, as a decimal string handle.
   *
   * This result reported the window's title, its class and its rectangle, and not which window it
   * was. That is the whole of item 15: a UIA entity therefore records no `origin.hwnd`, the
   * executor has no coordinate handle for it, and `resolvePressPoint` returns before its first
   * rung — so a UIA entity whose window has CLOSED is pressed blind at the remembered coordinates
   * and the caller is told `ok:true` (measured on Windows 2026-09-10, win2,
   * `dev/item13-detail/RESULTS-round2.md`).
   *
   * Reported by both roads and by construction rather than by a second lookup: the native path
   * reads it from the cached root it walked, the PowerShell path from the element it resolved,
   * and a scoped read already knows it. **Re-resolving the title here would be a different
   * question** — the title can find a different window on the second ask, which is the class of
   * error this ADR keeps finding.
   *
   * Absent when the read could not report one; never `"0"` — "no window" and "window 0" are not
   * the same fact.
   */
  windowHwnd?: string;
  /** Bounding rectangle of the root window in screen coordinates. */
  windowRect?: { x: number; y: number; width: number; height: number } | null;
  elementCount: number;
  /**
   * ADR-036 — true when the PowerShell walk stopped because its time ran out, so the tree is a
   * prefix rather than the window. Absent on the native path, which has no such clock. A caller
   * that compares two snapshots has to refuse this; one that shows what it found need not.
   */
  truncated?: boolean;
  /**
   * ADR-036 — whether the PowerShell read could see the window's FRAME (title bar, menu, close
   * button), which the managed UIA client reaches only through the clientside providers.
   *
   * `"registered"` — the assembly was registered and the tree grew, so the frame is in there.
   * `"noop"` — registered without effect; the tree is the client area only (measured on a WPF
   * window, which publishes its own UIA and gives the MSAA synthesis nothing to add). `"failed"`
   * / `"unavailable"` — the registration threw, or this .NET has no such method. Absent on the
   * native path, which goes through COM and never needed any of it.
   *
   * Reported rather than assumed because the failure is silent: registering at the wrong moment
   * returns without error and changes nothing.
   *
   * **`"registered"` also means the names in this tree are the synthesised ones.** The same
   * Notepad returns 26 elements on both roads and they are not the same 26: through the
   * clientside providers the frame is `Button:Close` / `Button:Minimize` /
   * `MenuBar:Application`, through COM it is `Button:閉じる` / `Button:最小化` /
   * `MenuBar:アプリケーション`, and control types differ too (`Document` against `Edit`,
   * `Edit` against `Text`). Twenty of the twenty-six differ. A caller that addresses elements by
   * name — this product does — sees one window under two vocabularies depending on whether it
   * passed a handle.
   *
   * Kept anyway, because the alternative is that a session holding a window's handle cannot
   * press that window's close button at all, and because the vocabulary is self-consistent
   * within one road: a pinned discover and the pinned act that follows it both speak MSAA. It
   * goes away when the native side takes a handle, which is the next change.
   */
  clientProviders?: "registered" | "noop" | "failed" | "unavailable";
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
     * parameter: `screenshot` passes a handle to key the cache, and making that scope the read
     * took the Rust path away from it. Two things that are not the same thing do not share a
     * name.
     *
     * Scoping is not free — it is the PowerShell path, and a deep tree comes back `truncated`
     * where the native walker would have finished. `get_ui_elements` pays it deliberately
     * (`ui-elements.ts`): it resolves a window and then reports which one it read, so a read of
     * a different window would make that report false. `screenshot` does not pin, and keeps the
     * native path. The cost goes away when the native side takes a handle, not before.
     */
    pinnedHwnd?: bigint;
    fetchValues?: boolean;
  }
): Promise<UiElementsResult & { _cacheHit?: boolean }> {
  refuseUiaTitleIfExcluded(windowTitle);
  if (options?.pinnedHwnd !== undefined) refuseUiaHwndIfExcluded(options.pinnedHwnd);
  // Cache hit path — only when the caller provides a handle and asks for `cached`. The refusals
  // above run first and stay first: a window that may not be touched, or is gone, is not a thing
  // to answer from a cache. Note: the cache is never used when fetchValues:true (values may have
  // changed).
  //
  // (An earlier version of this comment explained the ordering by a scoping gate that used to sit
  // below and sweep every top-level window. The gate is gone — see the note above the scripts —
  // and the sentence outlived it by a round, which is the thing this file keeps catching itself
  // doing.)
  // One key for the probe and the write: they had opposite precedence for a while, so a caller
  // passing both a scoping handle and a different cache key would have written under one and
  // looked under the other — a permanent miss, and a title-derived tree answering a scoped
  // request (2ゲート目の指摘).
  const cacheKey = options?.pinnedHwnd ?? options?.hwnd;
  if (options?.cached && cacheKey !== undefined && !options.fetchValues) {
    const cached = getCachedUia(cacheKey);
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
  // The key above says which window this result describes: the scoped handle when there is one,
  // because a scoped read is the only one that can vouch for the window it read; otherwise the
  // handle the caller keyed by, which is the caller's own claim that its title names that window.
  // That claim is as old as the cache and is not what this ADR changed.
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
        windowHwnd: result.windowHwnd ?? undefined,
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
    timeoutMs,
  );
  // The script ends its walk inside the caller's deadline and then prints, having measured its
  // own start rather than being told what it cost. Before that it walked to a fixed 8 s while the
  // wait was also 8 s, so a saturated walk produced nothing at all rather than a truncated
  // answer (2ゲート目の指摘).
  const output = await runPS(script, timeoutMs);
  const result = JSON.parse(output);
  if (result.error) throw new Error(result.error);

  // A prefix of a window is not the window: caching it would serve it to `screenshot` for the
  // whole TTL as though it were complete.
  if (cacheKey !== undefined && !result.truncated) {
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
    // The deadline is the read's, not the process start's — see `psReadWaitMs`. Only on the
    // scoped path: every other caller here has been passing a deadline it treats as a hard one
    // (`terminal.ts` reads a baseline and a post-read around every send), and quietly adding
    // four seconds to each of them is not this ADR's business (2ゲート目の指摘).
    const out = await runPS(script, scopeHwnd !== undefined ? psReadWaitMs(timeoutMs) : timeoutMs);
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
 * BOTH conditions count elements, so a truncated walk cannot answer either of them: the count it
 * carries describes the prefix that came back before the deadline, not the window. A healthy but
 * slow tree cut short of five elements was being labelled `too-few-elements`, and the same cut can
 * leave a top-level Pane with fewer than five actionable siblings, which is `single-giant-pane` —
 * so the refusal has to sit in front of both branches rather than in front of the sparsity one
 * (PR 側 codex + win2, 2026-09-09). Downstream that verdict is not cosmetic: `composeProviders`
 * escalates the OCR lane on it and publishes constraints describing the app as UIA-blind.
 *
 * A truncated tree therefore returns "not blind, and not decided" rather than "not blind": the two
 * are different answers, and a caller that logs the verdict should be able to tell them apart. The
 * `blind:false` half keeps the shape every existing caller reads.
 *
 * @returns `{ blind: false }` when the UIA tree looks healthy.
 *          `{ blind: false, undecided: "truncated_tree" }` when the walk was cut short — no
 *          evidence either way. Discover publishes `uia_tree_truncated` for the same fact.
 *          `{ blind: true, reason }` when the Sparsity conditions are met.
 */
export function detectUiaBlind(
  result: UiElementsResult,
): { blind: false; undecided?: "truncated_tree" } | { blind: true; reason: UiaBlindReason } {
  // Insufficient evidence, not a healthy tree — see the JSDoc. Ahead of both conditions because
  // both of them are counts, and a prefix's count is a lower bound.
  if (result.truncated) {
    return { blind: false, undecided: "truncated_tree" };
  }

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
