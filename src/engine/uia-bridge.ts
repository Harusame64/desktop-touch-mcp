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
/**
 * A PowerShell failure with the SCRIPT taken out of it — internal #148.
 *
 * `execFile` builds its message as `Command failed: <the whole command line>`, and the command line
 * here is a thirty-line script. Every road that lets that error escape hands the caller a few
 * kilobytes of PowerShell — and worse than the tokens, **the script decides the error code**:
 * `classify` matches by substring, and the discover script contains
 * `$wantedPats.Add('InvokePattern')`.
 *
 * MEASURED 2026-09-21 win2 (internal `c6d5e00`): with a window's UI thread hung,
 * `get_ui_elements` answered **`InvokePatternNotSupported`** after 18 s — five suggestions about
 * invoke patterns, for a window that was merely not answering, about an element that supports
 * invoke perfectly well. Nothing in this product chose that code. A line of the script did.
 *
 * #697 clamped this at ONE road (`getElementBounds`). The clamp lives on the PRODUCER now, so a
 * road cannot lose it by being written later. The fields the roads read are carried across:
 * `killed` separates this module's own budget from someone else's kill, `stdout` is the answer a
 * killed process may already have printed, `stderr` is what the client actually said.
 */
function clampPsFailure(e: unknown): Error {
  const killed = typeof e === "object" && e !== null && (e as { killed?: boolean }).killed === true;
  const clamped = new Error(shortPsFailure(e, killed));
  clamped.name = "PowerShellFailure";
  for (const key of ["killed", "stdout", "stderr", "code", "signal"] as const) {
    const v = (e as Record<string, unknown> | null)?.[key];
    if (v !== undefined) (clamped as unknown as Record<string, unknown>)[key] = v;
  }
  return clamped;
}

/** Whether a thrown value is a PowerShell road's failure, with its message already clamped. */
export function isPowerShellFailure(e: unknown): e is Error & { killed?: boolean; stdout?: string; stderr?: string } {
  return e instanceof Error && e.name === "PowerShellFailure";
}

export async function runPS(script: string, timeoutMs = 8000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: timeoutMs, windowsHide: true }
    );
    return stdout.trim();
  } catch (e) {
    throw clampPsFailure(e);
  }
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
# handle and silently keep the behaviour this item exists to end (PR 側 codex on #619, P2).
#
# **The mask is [uint32]::MaxValue and NOT 0xFFFFFFFF.** PowerShell types the hex literal
# 0xFFFFFFFF as Int32 -1, in 5.1 and in 7 alike, so -band 0xFFFFFFFF is the IDENTITY on a negative
# value: the cast below then receives the negative number and THROWS, straight into the catch,
# leaving $winHwnd null. That is the same silent no-handle outcome the mask was added to prevent —
# the fix failing into the bug's own path, for exactly the windows it was written for. Measured on
# Windows 2026-09-10 (win2, dev/item15-handle-width/), the shipped expression against three working
# forms, identical in 5.1.26100.9444 and 7.6.5.
$winHwnd = $null
try {
    $h = $target.Current.NativeWindowHandle
    if ($h -ne 0) { $winHwnd = [string][uint32]([int64]$h -band [uint32]::MaxValue) }
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
# ORDER MATTERS. Registering straight after Add-Type does not take — measured, four ways: no
# registration 2 elements, registration alone 2, warm-up alone 2, warm-up THEN registration 26.
# So the warm-up call below is not a spare RPC; it is what makes the next line take effect.
#
# Whether the failed case is SILENT is an open contradiction, and the account of it lives on
# PS_REGISTER_CLIENTSIDE_PROVIDERS_CALL in this file, not here. This arm ran the registration
# inside a try/catch, so a throw would have been swallowed and the script would have gone on to
# return 2 — which is what it recorded either way.
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
    # ADR-036 family 2 — the element's own window, when it is one. Written exactly as $winHwnd is
    # above (unsigned through [uint32]::MaxValue, zero dropped), so this road and the native one
    # give the same string for the same control, and the keyboard rung's receiver compares with it.
    $elHwnd = $null
    # ADR-036 internal#118 — and WHY it is absent, kept apart at the read: a throw is not a zero,
    # and a zero is not a windowless element by accident. The rule that refuses other_control is
    # decided from the handle alone, so the three cases must not arrive as one.
    # (No backticks in this comment on purpose: the script is a TS template literal.)
    $elHwndRead = 'failed'
    try {
        $eh = $el.Current.NativeWindowHandle
        if ($eh -ne 0) { $elHwnd = [string][uint32]([int64]$eh -band [uint32]::MaxValue); $elHwndRead = 'value' }
        else { $elHwndRead = 'zero' }
    } catch {}

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
    if ($null -ne $elHwnd) { $elObj['nativeWindowHandle'] = $elHwnd }
    $elObj['nativeWindowHandleRead'] = $elHwndRead
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
 * So a pinned read is scoped, always. The round trip was the price of that until the engine
 * learned to take a handle, which it now does: `uiaGetElements`, `uiaGetTextViaTextPattern`,
 * `uiaClickElement` and `uiaSetValue` all accept one, and a pinned call stays in Rust.
 *
 * The scripts below are what is left of that road — reached on a build with no native addon, or
 * when a native call throws. They keep every guard the pinned path grew while it lived here (the
 * budget the script measures for itself, the clamps around it, the catch around `FromHandle`,
 * the clientside-provider registration and the warning about the vocabulary it brings), because
 * a fallback that quietly does less than the road it replaces is the failure this ADR is about.
 */

/**
 * The registration on its own, for the roads that have already touched UIA by the time they get
 * here.
 *
 * What the call needs is not a warm-up on `$target` — it is that the process has made ANY UIA
 * call first. MEASURED 2026-09-20 win2 (internal `f3ce315`): a title search alone is enough.
 *
 * **THE ONE ACCOUNT of what a too-early registration does, because two rounds disagree and the
 * disagreement was shipped in four places before anyone noticed.** Both observations, dated:
 *
 * - 2026-09-09, inside `makeGetElementsScript`: registering straight after `Add-Type` left the
 *   read at 2 elements and the script ran to the end. Recorded as "nothing throws".
 * - 2026-09-20, win2, a bare probe: the same call threw `NullReferenceException`, on both
 *   fixtures.
 *
 * They reconcile if the 2026-09-09 arm swallowed the throw — it ran inside `try { … } catch {}`,
 * so a script that threw and a script that quietly did nothing both end at 2 elements and both
 * run to the end. **That is a hypothesis and nobody has measured it**; it is written here so the
 * next reader inherits the question rather than one of the two answers. What is not in doubt is
 * the instruction: register after some UIA call, never as the first one.
 *
 * A THIRD case is separate from both and is measured: a window class that publishes its own UIA
 * (a WPF window) registers successfully and gains nothing. The discover read reports it as
 * `clientProviders: "noop"`, and that is the case where silence is real.
 */
const PS_REGISTER_CLIENTSIDE_PROVIDERS_CALL = `
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
 * The warm-up AND the registration, for the roads whose only door to the window is `FromHandle`.
 * A title road needs no warm-up of its own — its search is one; a handle road was never measured
 * without one, so it keeps it. The const above says what the warm-up is for, and carries the one
 * thing about it that two rounds disagree on.
 *
 * Why this matters on the WRITE roads specifically, measured 2026-09-09: the registration is
 * process-local and every call is a fresh `powershell.exe`, so a discover that registered and an
 * act that did not are two views of one window. Discover returned Notepad's `Close` button and
 * the act could not find it; the executor then downgraded to a mouse click at the entity's stale
 * rect and answered `ok:true`, with the truth only in `downgrade`, and on `Minimize` that rect
 * was already `-32000,-32000`. The frame one road could SEE was only ever pressable through the
 * blind fallback this ADR exists to remove.
 */
const PS_REGISTER_CLIENTSIDE_PROVIDERS = `
# Guarded: this runs between resolving the window and the walk, inside the stretch a window can
# vanish in, and a bare FindAll there threw ElementNotAvailableException straight out of the
# script — so the caller got an exec failure instead of the gone code the surrounding try/catch
# prints (2ゲート目の指摘). A warm-up that could not run is not fatal on its own; the registration
# below is already best-effort, and the walk that follows raises the real refusal.
#
# This text IS part of the script, and the title road must not so much as mention the handle
# road's gone code: a cell reads these scripts for that word, because a title search that stops
# matching is a search that found nothing rather than a window that left. Spelling it here
# reddened that cell the moment this snippet reached the roads that resolve by title (internal
# #136) — the comment was making a claim about the road it had been pasted into.
try { $null = $target.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Automation]::ControlViewCondition) } catch {}
${PS_REGISTER_CLIENTSIDE_PROVIDERS_CALL}`;

/**
 * ADR-036 internal #136 — find a window by its title, and leave this client able to SEE it.
 *
 * The registration above was added to the roads that resolve a window by HANDLE, and to the
 * discover read. It was never added to the roads that resolve the same window by TITLE — so in
 * three of these generators the two branches of ONE function disagreed about what the window
 * contains: `makeClickElementScriptByHwnd` registered and `makeClickElementScript` did not, and
 * the same split ran through the value write and `insertTextViaTextPattern2`. Four scripts out of
 * fourteen carried it.
 *
 * What that costs is not a count. Without the registration this client reaches a legacy window's
 * title bar, menu bar and close button through nothing at all — they are synthesised from MSAA by
 * an assembly registered per process — so a caller that NAMED its window got a tree with no frame
 * in it, while the same caller holding a handle got the frame. The frameless side is measured and
 * stands on its own: a WinForms fixture answers 2 descendants before registering and 10 after, the
 * new ones being the title bar, the menu bar, the caption buttons and the menu items; Notepad
 * answered 2 here where the engine answered 26 (2026-09-09). No count of the new ones is given
 * because the first draft wrote "the six new ones" beside a delta of eight (gate 2) — arithmetic
 * nobody can check against a record is worse than the record's own words. A second comparison against the engine, taken
 * 2026-09-20 (win2, internal `bdef099`, arm R6, 8 against 2), is NOT cited here: its native half
 * was taken with a stale addon, and whether that particular round was affected has not been
 * established.
 *
 * So this is not only the discover read's problem. `getElementBounds` is what `wait_until` polls
 * and what the mouse's tier-3 re-query asks, and on this client a wait for `Close` could never
 * end. ADR-036 item 16 weighs "the element was not found" by WHICH client answered — a rule that
 * assumes the two clients see the same tree, which here they demonstrably did not.
 *
 * What this does NOT fix: registering makes this client see the frame, and does not make it agree
 * with the engine about what is in it. On the managed side, measured: a WinForms window goes from
 * 2 descendants to 10 — title bar, menu bar, caption buttons and menu items — and one of those
 * controls is reported as a `Pane` before registering and a `Button` after, so
 * registering changes the control TYPE as well as the membership, and the two readings of one
 * control differ by more than whether it is there.
 *
 * And it does not make the two clients speak the same names. That is not new and is not this
 * change's to fix — it is written out on `clientProviders` in the read's own types, from the round
 * that added the field: the same Notepad returns 26 elements on both roads and twenty of them
 * differ, `Button:Close` here against `Button:閉じる` there, control types included. So a caller
 * that read a name from the engine and hands it to one of these scripts can still miss, and
 * registering moves which vocabulary this road speaks rather than removing the second one. That is
 * why #136 does not close on this change.
 *
 * Every caller has `$root` and `$trueC` in scope before this, and reads `$target` after it. The
 * registration goes last and needs no warm-up of its own: what it requires is that the process
 * has made SOME UIA call first, and the search above is one — measured the same day, against the
 * spelled-out warm-up, with the same ten elements either way. Registering with nothing before it
 * throws rather than doing nothing quietly, which is the case the snippet above guards for the
 * roads that resolve by handle.
 */
/**
 * The element that is the window wearing another name: the synthesised title bar whose `Name` is
 * the window's own caption. Written once and used by all six searches in this file — five flat
 * descendant loops and the shared walk, which has five callers of its own, so ten roads — because
 * a guard spelled separately in ten places is a guard that will be nine places next month. (Gate 2
 * found this sentence saying "four", which is the count of scripts that already registered: a
 * number carried one paragraph too far.)
 *
 * Needs `$c` (the element under test) and `$targetName` (the window's caption, read once before
 * the walk) in scope. Internal #136.
 */
const MIRRORS_THE_WINDOW =
  `$c.ControlType.ProgrammaticName -eq 'ControlType.TitleBar' -and $targetName -ne '' -and $c.Name -eq $targetName`;

/**
 * …and WHEN it applies: only to a search made by NAME, and only when the caller said nothing about
 * the type.
 *
 * MEASURED 2026-09-20 win2 (internal `e105936`, arm D4). The first version put the guard in every
 * search unconditionally, and it took the title bar away from the one call that unambiguously
 * wants it: `getElementBounds(window, name: undefined, controlType: "TitleBar")` answered the
 * title bar's rectangle before and `null` after. With no name given the name filter is `$true`, so
 * a guard whose entire subject is a NAME landing on the wrong element fired on a caller who had
 * named nothing — and left no way to address a window's title bar from these roads at all. Moving
 * a window by dragging its caption is a real call.
 *
 * A caller who gave a `controlType` has already said more than a name: the type filter is what
 * discriminates then, and for any type but a bar it excludes the title bar outright.
 *
 * Decided in TypeScript rather than tested in PowerShell, so a search that does not need the guard
 * does not carry it and does not pay the property read it needs either. What is saved is the
 * `$target.Current.Name` READ — not a search. `FindAll` is called the same number of times either
 * way, which is worth saying because the count of those is what the next reader will reach for.
 *
 * MEASURED 2026-09-20 win2 (internal `dc652ad`), off the scripts the product generated: a search
 * by name is 195 characters longer than the same search by type, and the 195 are the two caption
 * lines and this clause. The version before this one paid them on every call.
 *
 * TWO THINGS NOBODY HAS MEASURED, so the next reader inherits them rather than the impression that
 * this was settled (gate 2):
 *
 * - The guard fires on EVERY name-only search, including against a window where registering was a
 *   no-op — one that publishes its own UIA, where the frame was in this road's tree before any of
 *   this. On such a window a name-only search that used to answer a real title bar now answers
 *   not-found. The way out is `controlType`, and `set_element_value`, the scroll roads and the
 *   mouse's tier-3 re-query have no type to opt out with. Closing it needs a measurement on a
 *   window with a custom caption that publishes its own UIA.
 * - What the REGISTRATION costs in time. The saving above is a string length; the cost is that ten
 *   roads now walk a tree several times larger (2 → 10 on a WinForms window, 2 → 26 on Notepad),
 *   with a `.Current` read per element. `getTextViaTextPattern` and `getTextViaValuePattern` are
 *   the two that could feel it: both run on a 6-second budget, and the second is on the keyboard's
 *   background-type verification path, where a slower read becomes a null read and then an
 *   `unverifiable`.
 */
function mirrorGuardPs(name: string | undefined, controlType: string | undefined): string {
  return name && !controlType ? ` -and -not (${MIRRORS_THE_WINDOW})` : "";
}

/** The caption, read once before a walk that is going to need it — and not read when it is not. */
function captionReadPs(guard: string): string {
  return guard === "" ? "" : `$targetName = ''\ntry { $targetName = $target.Current.Name } catch {}\n`;
}

function makeResolveWindowByTitlePs(safeTitle: string, notFoundJson: string): string {
  return `$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '${notFoundJson}'; exit }
${PS_REGISTER_CLIENTSIDE_PROVIDERS_CALL}`;
}

/**
 * (H3) Click an element by finding the window via HWND directly.
 * AutomationElement.FromHandle() bypasses the title-based root search,
 * which fixes WindowNotFound for common dialogs whose title is not visible
 * in the root children list (e.g. Save As on Windows 11 Notepad).
 */
/**
 * The search every PowerShell READ shares: the first DESCENDANT of `$target`, depth-first, parent
 * before child, that matches `match` — and **never `$target` itself**.
 *
 * internal #134. All five of these started at the window (`FindElement $target 0` with the match
 * test at depth 0), so a name the window's TITLE contains answered with the window: MEASURED
 * 2026-09-20 win2 (internal `bdef099`) — `wait_until` `element_appears` returned `ok:true` at once
 * with the window's rect, the `mouse_click` tier-3 re-query aimed at the window's centre, and two
 * entries (`value_changes`, `scroll(action='to_element')`) answered byte-for-byte what they answer
 * when nothing matched, hiding it. The native half tested the window too, which is why this moved
 * with it rather than after it (internal #133 moved the acts; both clients move together or the
 * roads split).
 *
 * …and **never the title bar that merely repeats `$target`'s name** — internal #136, gate 2.
 * Registering the clientside providers puts a synthesised `TitleBar` in this walk as a depth-1
 * child whose `Name` is the window's caption, and every search here takes the FIRST match of
 * `-like '*needle*'`.
 *
 * MEASURED 2026-09-20 win2 (internal `e105936`), which narrowed this from what was first written
 * here. What was first written was that the frame comes ahead of the client area; on that fixture
 * the children come back `MenuBar, Button, TitleBar, MenuItem, …`, so the frame straddles it — a
 * menu bar first, the client control second, the caption-mirroring title bar third. A needle
 * present in both the caption and a control therefore reached the control, on all three builds of
 * that window. **That ordering is a measurement of one window and nothing more** (gate 2 caught
 * the first draft generalising it to every build): nobody has looked for a window whose title bar
 * comes first, and on one the same defect would show up in that case too.
 *
 * What fires here is the case that does not depend on the order — a needle that occurs ONLY in the
 * caption, where the walk reaches the title bar because nothing else matched. For a window called `RCD136-SAVEQ-…`, `getElementBounds(window,
 * "SAVEQ")` answered `{name: <the caption>, controlType: TitleBar}`, a 23-pixel strip across the
 * top, and `wait_until` answered `ok:true` with it. With the guard both answer what they answered
 * before the registration existed: not found.
 *
 * So it is #134's defect one element deeper, and the same shape: a search that finds nothing used
 * to say so, and came to answer with the window instead. The window was already behind a guard;
 * its title bar was not.
 *
 * Narrow on purpose: a title bar whose name is NOT the window's caption still matches, and so does
 * one asked for by control type — see `mirrorGuardPs` for when this clause is emitted at all, and
 * for the call it took away before that was measured. The caption is read once, before the walk,
 * rather than per element.
 *
 * The frame stays REACHABLE — the walk descends through the title bar as before, so `Close` and
 * `Minimize` are found as its children, which is what the registration was added for.
 *
 * `$trueC` and `$target` are the caller's; `$script:found` is what it reads afterwards. The depth
 * cap counts descendants, so `maxDepth` keeps the reach each road had.
 */
function makeFindDescendantPs(match: string, maxDepth: number, guard = ""): string {
  return `$found = $null
${captionReadPs(guard)}function FindElement($el, $depth) {
    if ($script:found) { return }
    if ($depth -gt 0) {
        $c = $el.Current
        if ((${match})${guard}) { $script:found = $el; return }
    }
    if ($depth -gt ${maxDepth}) { return }
    $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
    foreach ($k in $kids) { FindElement $k ($depth+1) }
}
FindElement $target 0`;
}

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
${captionReadPs(mirrorGuardPs(name, controlType))}try {
$all   = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter}) -and (${typeFilter})${mirrorGuardPs(name, controlType)}) { $found = $el; break }
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
${captionReadPs(mirrorGuardPs(name, undefined))}try {
$all   = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter})${mirrorGuardPs(name, undefined)}) { $found = $el; break }
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

${makeResolveWindowByTitlePs(safeTitle, `{"ok":false,"error":"Window not found"}`)}

$found = $null
${captionReadPs(mirrorGuardPs(name, controlType))}$all = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter}) -and (${typeFilter})${mirrorGuardPs(name, controlType)}) {
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

${makeResolveWindowByTitlePs(safeTitle, `{"ok":false,"error":"Window not found"}`)}

$found = $null
${captionReadPs(mirrorGuardPs(name, undefined))}$all = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter})${mirrorGuardPs(name, undefined)}) { $found = $el; break }
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
  /**
   * ADR-036 family 2 — the element's own window handle, as a decimal string, when it is a window of
   * its own (UIA `NativeWindowHandle`; Win32 and WinForms controls are). Absent for a windowless
   * element, and on a read that could not say. Both roads write it the way they write `windowHwnd`:
   * unsigned 32-bit, zero dropped.
   */
  nativeWindowHandle?: string;
  /**
   * ADR-036 `internal#118` — WHY `nativeWindowHandle` is absent, because absence meant three things
   * and the rule that refuses `other_control` is decided from it alone:
   *   - `"value"`  — the property answered a non-zero handle;
   *   - `"zero"`   — it answered 0: UIA says this element is not a window of its own;
   *   - `"failed"` — the read did not answer at all.
   * Observation only; nothing branches on it. Absent on a read taken before this field existed.
   */
  nativeWindowHandleRead?: "value" | "zero" | "failed";
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
  // `$true` / `$false`, not JavaScript's spelling. internal #138: this read `"true"`, and
  // PowerShell has no such literal — a bare `true` in a condition is an unresolved command name,
  // which `if ()` takes as FALSE. So `if (true) { … }` around the point read never ran, on every
  // call, since the road was written. MEASURED 2026-09-20 win2 (internal `cadc06f`): the product's
  // own generated script, run as the product runs it, printed `{"focused":{…},"atPoint":null}` with
  // an EMPTY stderr and exit code 0 — the block was skipped in silence, and `if (true) { "YES" }
  // else { "NO" }` printed `NO` on the same host.
  const includePointPS = includePoint ? "$true" : "$false";
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
        } else { $result.atPointWhy = 'from_point_empty' }
    } catch { $result.atPointWhy = "threw: $($_.Exception.GetType().Name)" }
}

$result | ConvertTo-Json -Compress
`;
  try {
    const output = await runPS(script, timeoutMs);
    const parsed = JSON.parse(output) as {
      focused?: Record<string, string | undefined> | null;
      atPoint?: Record<string, string | undefined> | null;
      /**
       * internal #138 — why the point read has nothing, when it has nothing. Every failure inside
       * that block used to collapse into `atPoint: null`, which is also what "the point is over
       * nothing" answers, and that is how a branch that never ran survived unnoticed for the life
       * of the road. The name is not routed on; it is printed so the next silence has a reason
       * beside it.
       */
      atPointWhy?: string;
    };
    if (parsed.atPointWhy !== undefined) {
      console.warn(`[uia-bridge] PowerShell point read answered nothing: ${parsed.atPointWhy}`);
    }
    const toInfo = (obj: Record<string, string | undefined> | null | undefined): UiaFocusInfo | null => {
      if (!obj || dropFocusRow(obj.name, obj.controlType, includeUnnamed)) return null;
      const info: UiaFocusInfo = { name: obj.name ?? "", controlType: obj.controlType ?? "" };
      if (obj.automationId) info.automationId = obj.automationId;
      if (obj.value != null) info.value = obj.value;
      return info;
    };
    const atPoint = toInfo(parsed.atPoint);
    // internal #138, gate 2 — the OTHER way this answer becomes nothing, and after the fix it is the
    // likelier one: the read found an element and `dropFocusRow` dropped it for having no Name. The
    // element under a cursor is unnamed far more often than the focused one is (a Pane, a Document,
    // a Chromium sub-tree), and without this line that lands on `atPoint: null` with no reason — the
    // shape `atPointWhy` exists to end. It is also the measurement internal #139 needs: how often
    // the channel is empty because nothing is named, rather than because nothing could be read.
    if (atPoint === null && parsed.atPoint != null) {
      console.warn("[uia-bridge] PowerShell point read answered nothing: dropped_unnamed");
    }
    return { focused: toInfo(parsed.focused), atPoint };
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
  /**
   * Which client read this tree — ADR-036 item 16. The two name one element in different
   * vocabularies (above), and without the native engine the title-road click script, which does
   * not register the clientside providers, sees fewer elements than this read (gate 2 on #624). So
   * a click's "not found" is believed only when the native engine both read the element and looked
   * for it — a PowerShell pair is not measured, and is not believed either. Absent on a result that cannot say — a cache entry written from a PowerShell read.
   */
  via?: "native" | "powershell";
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
  // ADR-036 — this used to be skipped for a scoped read, because `uiaGetElements` took a title
  // and nothing else: going through it would have read whichever window the title found first
  // while every write on the session addressed the handle. The engine takes a handle now, so a
  // pinned read stays here — which is the whole of the next change and most of what it buys.
  // What it costs to leave: 184 ms against 517 ms on the same window, a frame the PowerShell
  // road can only see by registering MSAA clientside providers, and English names for that
  // frame when it does (measured on Windows 2026-09-09).
  if (nativeUia?.uiaGetElements) {
    try {
      const result = await nativeUia.uiaGetElements({
        windowTitle,
        maxDepth,
        maxElements,
        fetchValues: options?.fetchValues ?? false,
        ...(scopeHwnd !== undefined && { hwnd: scopeHwnd.toString() }),
      });
      // Normalise: Rust returns Option<T> as undefined; TS expects null for rects
      const normalised: UiElementsResult = {
        windowTitle: result.windowTitle,
        windowClassName: result.windowClassName ?? undefined,
        windowHwnd: result.windowHwnd ?? undefined,
        windowRect: result.windowRect ?? null,
        elementCount: result.elementCount,
        elements: result.elements.map(({ nativeWindowHandle, nativeWindowHandleRead, ...el }: NativeUiElement) => ({
          ...el,
          boundingRect: el.boundingRect ?? null,
          // Rust's `None` arrives as null. This type says "absent", as the PowerShell road does, so the
          // key is left out rather than set to undefined.
          ...(nativeWindowHandle != null && { nativeWindowHandle }),
          // `internal#118` — and WHY it is absent, kept beside it. A build older than the field sends
          // nothing, which stays absent rather than becoming a guess.
          ...(nativeWindowHandleRead != null && { nativeWindowHandleRead: nativeWindowHandleRead as "value" | "zero" | "failed" }),
        })),
        via: "native",
      };
      // A prefix of a window is not the window — the same rule the PowerShell road follows below.
      // Caching one would serve it to `screenshot` for the whole TTL as though it were complete.
      // Gate 2 found this: before this branch a pinned read took the PowerShell road, where the
      // refusal already existed, so the native road had never needed one.
      //
      // **Why a proxy and not the real witness.** `truncated` is raised by the PowerShell script
      // alone (`$truncated = ($queue.Count -gt 0) -and ($sw.ElapsedMilliseconds -ge $budgetMs)`,
      // below), and `uia-provider` records that value — but the native result has no such field, so
      // on this road it is always absent (win2 raised the better witness; counting it showed it does
      // not reach here). The proxy is the cap itself: a walk holding exactly as many elements as it
      // was allowed may have stopped early. It over-refuses (a window with exactly `maxElements`
      // elements is not cached) and never under-refuses, which is the side to be wrong on.
      // Reporting `truncated` from Rust is the real fix and is its own change, not this branch's.
      const maybeTruncated = normalised.elementCount >= maxElements;
      if (cacheKey !== undefined && !maybeTruncated) {
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
  return { ...(result as UiElementsResult), via: "powershell" };
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
): Promise<{ ok: boolean; element?: string; error?: string; code?: string; via?: "native" | "powershell" }> {
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
  // H3 — the handle is also what reaches the common dialogs (Save As on Win11 Notepad): they are
  // not among the UIA root children a title search walks, and `ElementFromHandle` does not walk
  // them either. The engine takes the handle now, so this no longer means leaving it.
  if (nativeUia?.uiaClickElement) {
    try {
      const result = await nativeUia.uiaClickElement({
        windowTitle,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
        controlType: controlType ?? undefined,
        ...(options?.hwnd !== undefined && { hwnd: options.hwnd.toString() }),
      });
      return {
        ok: result.ok,
        element: result.element ?? undefined,
        error: result.error ?? undefined,
        code: result.code ?? undefined,
        via: "native",
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
  // Which client answered — ADR-036 item 16 weighs a "not found" by it (see `UiElementsResult.via`).
  return { ...JSON.parse(output), via: "powershell" };
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
  if (nativeUia?.uiaSetValue) {
    try {
      const result = await nativeUia.uiaSetValue({
        windowTitle,
        value,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
        ...(options?.hwnd !== undefined && { hwnd: options.hwnd.toString() }),
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
  automationId?: string,
  /**
   * ADR-036 — the window this call is about, when the caller resolved one. The engine and its
   * declaration have taken a handle since this branch; this parameter is what carries it, because
   * a road that accepts a handle and then resolves by title is the defect the ADR exists to remove
   * (gate 2 found it accepted and dropped here). The PowerShell fallback below resolves by handle
   * too, and it is the half that actually inserts the text — the engine refuses when TextPattern2
   * is the road — so leaving the script by title would have moved the defect one line down rather
   * than removed it (PR 側 codex, P1 on #631).
   */
  options?: { hwnd?: bigint }
): Promise<{ ok: boolean; code?: string; error?: string }> {
  refuseUiaTitleIfExcluded(windowTitle);
  if (options?.hwnd !== undefined) refuseUiaHwndIfExcluded(options.hwnd);
  // ★ Rust native path (Phase C)
  if (nativeUia?.uiaInsertText) {
    try {
      const result = await nativeUia.uiaInsertText({
        windowTitle,
        value,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
        ...(options?.hwnd !== undefined && { hwnd: options.hwnd.toString() }),
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

  // ADR-036 — this fallback resolves by HANDLE when the caller gave one, as the click and the value
  // write already do. It is the half that actually inserts the text: the engine above refuses when
  // TextPattern2 is the road, so on a real machine this script runs, and resolving it by title would
  // insert into a same-titled sibling while the caller held an authoritative handle (PR 側 codex, P1
  // on #631 — the last road that still traded the handle away). `FromHandle` throws for a window that
  // has gone, so the catch prints the gone code rather than dying with empty stdout.
  const resolveTargetPs = options?.hwnd !== undefined
    ? `$hwndPtr = [System.IntPtr]::new(${options.hwnd.toString()})
try { $target = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr) }
catch { Write-Output '{"ok":false,"error":"Window not found by hwnd","code":"${AIM_WINDOW_GONE}"}'; exit }
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found by hwnd","code":"${AIM_WINDOW_GONE}"}'; exit }
${PS_REGISTER_CLIENTSIDE_PROVIDERS}`
    : `$root = [System.Windows.Automation.AutomationElement]::RootElement
${makeResolveWindowByTitlePs(safeTitle, `{"ok":false,"code":"WindowNotFound"}`)}`;

  // ADR-036 — the window can go between resolving the target and the walk, and everything in the
  // stretch below throws ElementNotAvailableException when it does: `FindAll`, `$el.Current`. The
  // click and the value write have caught that since their own gate-2 round; this road had only the
  // `FromHandle` catch, so a window closing here died with a PowerShell exception, arrived as empty
  // stdout, and came back as a parse error instead of the gone code (PR 側 codex, P2 on #631).
  //
  // The code differs by road on purpose. Only a call that named a handle may answer
  // `aim_window_gone`: a title search is a search, and a window that stops matching a title is not
  // a window that left — so the title road answers with the same `WindowNotFound` its own miss
  // prints, and the executor's gone-code check stays blind to it by design.
  const lookupCatchPs = options?.hwnd !== undefined
    ? `} catch { Write-Output '{"ok":false,"error":"Window not found by hwnd","code":"${AIM_WINDOW_GONE}"}'; exit }`
    : `} catch { Write-Output '{"ok":false,"code":"WindowNotFound"}'; exit }`;

  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$trueC = [System.Windows.Automation.Condition]::TrueCondition
$desc  = [System.Windows.Automation.TreeScope]::Descendants

${resolveTargetPs}

$found = $null
${captionReadPs(mirrorGuardPs(name, undefined))}try {
$all = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    $c = $el.Current
    if ((${nameFilter}) -and (${idFilter})${mirrorGuardPs(name, undefined)}) { $found = $el; break }
}
${lookupCatchPs}
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
 * Why a bounds read came back with nothing — internal #142.
 *
 * `null` used to mean all of these at once, and the caller that has to explain a timeout
 * (`wait_until`) picked one and said it: MEASURED 2026-09-20 win2, a wait against a window title
 * matching no window at all answers `why: "element_not_found"` and advises checking the ELEMENT
 * name against `desktop_discover`. The element name was never the problem.
 *
 * Both clients know the difference and both roads threw it away, in two different places:
 * `get_element_bounds_impl` (`src/uia/tree.rs`) turns a failed `find_window` and a failed
 * `find_element_in_window` into the same `Ok(None)`, and the PowerShell script prints
 * `{"error":"Window not found"}` and `{"error":"Element not found"}` as distinct answers which
 * this file then collapsed with `if (parsed.error) return null`.
 *
 * This change stops the collapse on the road that still has the information. The native road
 * cannot say yet: `unreadable` is what it answers, and that is the honest value rather than a
 * guess, because the field does not exist in the addon. Closing it is a Rust change and a rebuilt
 * addon — and a build without that field must not be read as if it had one.
 */
export type BoundsMiss =
  /** The title matched no top-level window. Checking the element's name cannot help. */
  | "window_not_found"
  /** The window was there and nothing in it matched. */
  | "element_not_found"
  /**
   * The answer does not say which of the two it was — and the two roads reach that for OPPOSITE
   * reasons, so read `via` before writing advice on it.
   *
   * On the native road the engine computed the distinction and discarded it (`Ok(None)` for both a
   * failed `find_window` and a failed `find_element_in_window`, `src/uia/tree.rs`), so the answer
   * really is ambiguous and the recovery order — window first — is all that can be said.
   * On the PowerShell road the script said something SPECIFIC that this file did not recognise; the
   * words are carried in `error`, and calling that "cannot tell the two apart" would name the wrong
   * cause for text that is sitting in the answer.
   */
  | "unreadable"
  /**
   * The read itself failed — nothing was concluded about the window or the element.
   *
   * It says nothing about WHO failed: `via` does. A spawn that never started answers
   * `via: "none"`, while a script that ran and printed something unusable answers
   * `via: "powershell"`, because a client did speak. (This doc said "and no other client answered
   * either" until gate 2 read it against the two arms below it, which is the sort of sentence a
   * caller builds a wrong recovery on.)
   */
  | "read_failed"
  /**
   * The read was cut off by its own budget before it produced anything — nothing was concluded.
   *
   * MEASURED 2026-09-20 win2 (internal `0c5547d`): against a window whose UI thread is hung, this
   * road answers nothing in 16 seconds — 8000 ms of native timeout, then 8000 ms of `runPS`
   * timeout, spent one after the other. The script is killed with empty stdout.
   *
   * **It is the only one of these that is not a statement about the window or the element** —
   * nothing was observed at all. (Not "the only silence a longer wait can change": an element that
   * is not there YET is exactly what `wait_until` exists for, and gate 2 caught that sentence.) It
   * looked exactly like the three above, so a caller gave up on a read that had not finished. `runPS` passes a
   * fixed 8000 ms here where `getUiElements` takes the caller's own budget, which is why the same
   * hung window can be read by one road and not the other (internal #144).
   *
   * **It does not mean the TARGET is busy.** Measured the same day (win2, `30dac81`): reading a
   * title that matches no window at all takes 16 s while an unrelated window is hung, and 120 ms
   * before and after. A title search walks the root's children and reads `Current.Name` on each
   * one, so one unresponsive window on the desktop is a tax on every title search, whoever the
   * caller asked about. Advice that says "the window you named is busy" is wrong in exactly that
   * case, which is why the sentence in `wait-until.ts` is about the READ and not about the
   * window.
   */
  | "read_unfinished";

/**
 * Which UIA client produced an answer — or `none`, when the question was never answered at all.
 *
 * `none` is not a nicety. "If the native client fails, the PowerShell road answers" does not hold
 * when the cause of the failure is SLOWNESS: both budgets are 8000 ms and they are spent one after
 * the other, so a window slow enough to time out the engine is slow enough to time out the
 * fallback (win2, `0c5547d`). Writing `via: "powershell"` on that answer would claim a client
 * spoke when none did.
 */
export type UiaVia = "native" | "powershell" | "none";

/**
 * A bounds read, and the provenance of its answer — internal #142.
 *
 * `via` is WHO ANSWERED, not who was asked. That matters because the two clients do not name the
 * same control the same way (internal #136: `Minimize` here, `最小化` there; twenty of Notepad's
 * twenty-six elements differ, control types included). So a read that fell back from one client to
 * the other answered a different question than the caller asked, and the old shape had nowhere to
 * say so.
 *
 * `nativeFailed` is present whenever the native client was asked and threw — which is NOT the same
 * as "and PowerShell answered instead". It rides out on the `via: "none"` answers too, where the
 * fall-back was cut off by its own budget and nobody spoke; a reader who takes a present
 * `nativeFailed` as proof that PowerShell answered has the pair backwards, and the branch's own
 * cell ("separates a read that was cut off…") asserts exactly that combination. Read `via` for who
 * answered and `nativeFailed` for what the native road said on its way out.
 *
 * MEASURED 2026-09-20 win2 (internal `25da27f`): hanging the target window's UI
 * thread makes the native call throw `UIA operation timed out after 8000ms` while the PowerShell
 * road answers normally in 3.6 s — same call, same window, same moment. The caller got an ordinary
 * answer, and the only trace was a `console.warn` on the server's stderr.
 */
export type BoundsAnswer =
  | { found: ElementBounds; via: UiaVia; nativeFailed?: string }
  | { found: null; why: BoundsMiss; via: UiaVia; nativeFailed?: string; error?: string };

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

${makeResolveWindowByTitlePs(safeTitle, `{"error":"Window not found"}`)}

${makeFindDescendantPs(`(${nameFilter}) -and (${idFilter}) -and (${typeFilter})`, 12, mirrorGuardPs(name, controlType))}
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
    # ADR-036 family 2 — the element's own window, written as the get-elements script writes it
    # (unsigned through [uint32]::MaxValue, zero dropped), so the native road, which shares
    # extract_element with the element read, and this one give scope_element the same shape.
    $elHwnd = $null
    # internal#118 — the same three cases as the get-elements script, kept apart the same way.
    $elHwndRead = 'failed'
    try {
        $eh = $c.NativeWindowHandle
        if ($eh -ne 0) { $elHwnd = [string][uint32]([int64]$eh -band [uint32]::MaxValue); $elHwndRead = 'value' }
        else { $elHwndRead = 'zero' }
    } catch {}
    $item = @{
        name=$c.Name; controlType=($c.ControlType.ProgrammaticName -replace 'ControlType\\.','')
        automationId=$c.AutomationId; isEnabled=$c.IsEnabled
        boundingRect=$rect; patterns=$pats; depth=$depth
    }
    if ($null -ne $elHwnd) { $item['nativeWindowHandle'] = $elHwnd }
    $item['nativeWindowHandleRead'] = $elHwndRead
    $script:results.Add($item)
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
      return result.map(({ nativeWindowHandle, nativeWindowHandleRead, ...el }: NativeUiElement) => ({
        ...el,
        boundingRect: el.boundingRect ?? null,
        // Rust's `None` arrives as null. This type says "absent", as `getUiElements` does, so the key is
        // left out rather than set to undefined.
        ...(nativeWindowHandle != null && { nativeWindowHandle }),
        ...(nativeWindowHandleRead != null && { nativeWindowHandleRead: nativeWindowHandleRead as "value" | "zero" | "failed" }),
      }));
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
  // ★ Rust native path (Phase C) — takes the handle too now, so a pinned terminal read no
  // longer has to leave it. Reading one terminal's buffer while the keys go to its same-titled
  // twin is the split this ADR closed on the UIA route, and it was closed here by paying for
  // PowerShell until the engine could be told which window.
  if (nativeUia?.uiaGetTextViaTextPattern) {
    try {
      return await nativeUia.uiaGetTextViaTextPattern({
        windowTitle,
        timeoutMs,
        ...(scopeHwnd !== undefined && { hwnd: scopeHwnd.toString() }),
      });
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
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found by hwnd"}'; exit }
${PS_REGISTER_CLIENTSIDE_PROVIDERS}`
  : `${makeResolveWindowByTitlePs(safeTitle, `{"ok":false,"error":"Window not found"}`)}`}

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
${makeResolveWindowByTitlePs(safeTitle, `{"ok":false,"error":"Window not found"}`)}

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
/**
 * What a failed `runPS` is worth saying, without the script.
 *
 * `execFile` builds its message from the whole command line, and the command line here is the
 * generated PowerShell — MEASURED 2026-09-20 win2 (internal `c4374e9`): 2361 characters of script
 * arrived in `error`, on a road whose answer goes back to a model that reads every word of it. The
 * script is not evidence about the failure; it is the same string on every call.
 *
 * **The message is not parsed, because parsing it does not work.** The first version took "the
 * tail after the first line", on the reasoning that line one is `Command failed: <command>` and
 * the rest is stderr. The command here is a THIRTY-LINE script, so line one ends at the script's
 * first newline and the tail is the script's remaining lines, with the stderr past the end of the
 * clamp. It kept the one thing worth dropping and dropped the one thing worth keeping, and the
 * cell for it passed because its fixture put the script on a single line — a shape this producer
 * never emits (gate 2).
 *
 * `execFile`'s error carries `stderr` as a field, exactly as it carries the `stdout` the salvage
 * path above reads. That is what the process actually said.
 */
function shortPsFailure(e: unknown, killed: boolean): string {
  const head = killed
    ? "PowerShell read was cut off at its own budget before it answered"
    : "PowerShell read failed";
  const said = (e as { stderr?: string } | null)?.stderr?.trim().slice(0, 300);
  if (said) return `${head}: ${said}`;
  // No `stderr` field at all means this did not come from `execFile` — a spawn failure, a
  // programming error — and there the message IS the finding, so it is kept rather than clamped
  // away to a heading.
  const raw = e instanceof Error ? e.message : String(e);
  return raw && !raw.startsWith("Command failed:") ? `${head}: ${raw.slice(0, 300)}` : head;
}

export async function getElementBounds(
  windowTitle: string,
  name?: string,
  automationId?: string,
  controlType?: string
): Promise<BoundsAnswer> {
  refuseUiaTitleIfExcluded(windowTitle);
  /**
   * What the native client threw, if it was asked and it did. Carried onto whatever the PowerShell
   * road then answers, because the fall-back is the part the caller cannot otherwise see and the
   * two clients do not speak the same names (internal #136, #142).
   */
  let nativeFailed: string | undefined;
  // ★ Rust native path (Phase C)
  if (nativeUia?.uiaGetElementBounds) {
    try {
      const result = await nativeUia.uiaGetElementBounds({
        windowTitle,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
        controlType: controlType ?? undefined,
      });
      // `Ok(None)` from the engine is "no", with the reason discarded in Rust: `find_window` and
      // `find_element_in_window` both land here. `unreadable` says that, rather than picking one.
      if (!result) return { found: null, why: "unreadable", via: "native" };
      return {
        found: {
          name: result.name,
          controlType: result.controlType,
          automationId: result.automationId,
          boundingRect: result.boundingRect ?? null,
          value: result.value ?? null,
        },
        via: "native",
      };
    } catch (e) {
      nativeFailed = e instanceof Error ? e.message : String(e);
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

${makeResolveWindowByTitlePs(safeTitle, `{"error":"Window not found"}`)}

${makeFindDescendantPs(`(${nameFilter}) -and (${idFilter}) -and (${typeFilter})`, 12, mirrorGuardPs(name, controlType))}
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

  // The read is in two stages on purpose: RUNNING the script and READING what it printed are
  // different failures with different answers, and one `try` around both reported a client that
  // answered garbage as a client that never spoke (gate 2).
  let output: string;
  try {
    output = await runPS(script, 8000);
  } catch (e) {
    // Nothing was observed — and NOBODY answered, so `via` says so rather than crediting the road
    // that was cut off.
    //
    // The two silences are kept apart because only one of them can change with time: `execFile`
    // sets `killed` when IT ended the process, which is this module's own 8000 ms budget expiring
    // rather than the script deciding anything (win2, `0c5547d`: 16 s against a hung window, 8000
    // native plus 8000 here, stdout empty). `signal` would be the wrong test — a process killed by
    // someone else arrives as `{killed:false, signal:"SIGTERM"}`, and that is not our budget.
    const killed = typeof e === "object" && e !== null && (e as { killed?: boolean }).killed === true;
    // …but a killed process may have printed a complete answer before it was killed. Discarding it
    // to say "nothing was learned" would throw away the one thing that WAS learned (gate 2).
    const salvaged = (e as { stdout?: string })?.stdout?.trim();
    if (salvaged) {
      try { return answerFromPs(JSON.parse(salvaged), nativeFailed); } catch { /* not an answer */ }
    }
    return {
      found: null, why: killed ? "read_unfinished" : "read_failed", via: "none",
      // Already clamped, on the producer (internal #148): clamping it twice would spell the
      // heading into its own detail.
      error: e instanceof Error ? e.message : String(e),
      ...(nativeFailed !== undefined && { nativeFailed }),
    };
  }

  try {
    return answerFromPs(JSON.parse(output), nativeFailed);
  } catch (e) {
    // PowerShell DID answer, with something this road cannot read. A client spoke, so `via` names
    // it; `via: "none"` here was a claim the code could not support.
    return {
      found: null, why: "read_failed", via: "powershell",
      error: `PowerShell answered with something that is not JSON: ${e instanceof Error ? e.message : String(e)}`,
      ...(nativeFailed !== undefined && { nativeFailed }),
    };
  }
}

/**
 * What the PowerShell road printed, read as an answer.
 *
 * The script already tells the two misses apart — it prints one or the other and exits.
 * Collapsing them with `if (parsed.error) return null` is what made a wait against a window that
 * does not exist advise the caller to check the ELEMENT name (internal #142, measured).
 */
function answerFromPs(parsed: { error?: string } & Partial<ElementBounds>, nativeFailed?: string): BoundsAnswer {
  const carry = nativeFailed !== undefined ? { nativeFailed } : {};
  // `5`, `"text"`, `null` and `[]` are all valid JSON. Without this, the scalars become a truthy
  // `found` with no fields — which downstream reads as an element that was found and has no
  // rectangle, and advises the caller to scroll something that does not exist (gate 2). A wrong
  // answer, not a crash, which is the worse outcome.
  //
  // An ARRAY is the same harm through the one hole the first version of this guard left open:
  // `typeof [] === "object"` and it is not `null`, so `[]` walked past a check written to stop
  // exactly this (gate 2, third pass). Today's script cannot print one; the guard is a tier, and a
  // tier with a gap in it is the shape this whole change is about.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { found: null, why: "read_failed", via: "powershell", error: "PowerShell printed JSON that is not an object", ...carry };
  }
  if (parsed.error === undefined) return { found: parsed as ElementBounds, via: "powershell", ...carry };
  const known: BoundsMiss | undefined = parsed.error === "Window not found" ? "window_not_found"
    : parsed.error === "Element not found" ? "element_not_found"
    : undefined;
  // A third thing this road can print one day. Named `unreadable` rather than folded into either
  // of the two above — that folding is the mistake this change undoes — and it CARRIES what the
  // script said, because here `unreadable` does not mean "the engine cannot tell the two apart":
  // the script said something specific and only this file failed to recognise it (gate 2).
  return {
    found: null, why: known ?? "unreadable", via: "powershell",
    ...(known === undefined && { error: String(parsed.error) }),
    ...carry,
  };
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

${makeResolveWindowByTitlePs(safeTitle, `{"ok":false,"scrolled":false,"error":"Window not found"}`)}

${makeFindDescendantPs(`(${nameFilter}) -and (${idFilter})`, 12, mirrorGuardPs(name, undefined))}
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

${makeResolveWindowByTitlePs(safeTitle, `{"ok":false,"error":"Window not found","ancestors":[]}`)}

${makeFindDescendantPs(`$c.Name -like '*${safeName}*'`, 14, mirrorGuardPs(elementName, undefined))}

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

${makeResolveWindowByTitlePs(safeTitle, `{"ok":false,"scrolled":false,"error":"Window not found"}`)}

${makeFindDescendantPs(`$c.Name -like '*${safeName}*'`, 14, mirrorGuardPs(elementName, undefined))}
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
