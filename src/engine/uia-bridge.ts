import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCachedUia, updateUiaCache } from "./layer-buffer.js";
import { computeViewportPosition } from "../utils/viewport-position.js";
import { nativeUia, type NativeUiElement } from "./native-engine.js";

const execFileAsync = promisify(execFile);

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
  return s.replace(/[`*?\[\]]/g, (ch) => "`" + ch).replace(/'/g, "''");
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

function makeGetElementsScript(
  windowTitle: string,
  maxDepth: number,
  maxElements: number,
  fetchValues = false
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

# Find window by partial title (live query — before cache scope)
$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"error":"Window not found"}'; exit }
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

while ($stack.Count -gt 0 -and $count -lt ${maxElements} -and $sw.ElapsedMilliseconds -lt 8000) {
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
            $pn = $p.ProgrammaticName -replace 'Identifiers\.Pattern', ''
            if ($wantedPats.Contains($pn)) { $pats.Add($pn) }
        }
    } catch {}

    $ctName = ''
    try { $ctName = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '' } catch {}

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

$hwndPtr = [System.IntPtr]::new(${hwnd.toString()})
$target  = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr)
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found by hwnd"}'; exit }

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

$hwndPtr = [System.IntPtr]::new(${hwnd.toString()})
$target  = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr)
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found by hwnd"}'; exit }

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
// Focused element / element-at-point (for get_context & post narration)
// ─────────────────────────────────────────────────────────────────────────────

export interface UiaFocusInfo {
  name: string;
  controlType: string;
  automationId?: string;
  /** Present for focused element when ValuePattern is supported. */
  value?: string;
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
 */
export async function getFocusedAndPointInfo(
  x = 0,
  y = 0,
  includePoint = true,
  timeoutMs = 2000
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
        if (!obj || !obj.name) return null;
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
      if (!obj || !obj.name) return null;
      const info: UiaFocusInfo = { name: obj.name, controlType: obj.controlType ?? "" };
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
  options?: { cached?: boolean; hwnd?: bigint; fetchValues?: boolean }
): Promise<UiElementsResult & { _cacheHit?: boolean }> {
  // Cache hit path — only when caller provides hwnd + cached:true
  // Note: cache is never used when fetchValues:true (values may have changed)
  if (options?.cached && options.hwnd !== undefined && !options.fetchValues) {
    const cached = getCachedUia(options.hwnd);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as UiElementsResult;
        return { ...parsed, _cacheHit: true };
      } catch {
        // fall through to live fetch
      }
    }
  }

  // ★ Rust native path
  if (nativeUia?.uiaGetElements) {
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
      // Update cache if we know the hwnd
      if (options?.hwnd !== undefined) {
        try { updateUiaCache(options.hwnd, JSON.stringify(normalised)); } catch { /* ignore */ }
      }
      return normalised;
    } catch (e) {
      console.warn("[uia-bridge] Native uiaGetElements failed, falling back to PowerShell:", e);
      // fall through to PowerShell
    }
  }

  // PowerShell fallback (existing implementation)
  const script = makeGetElementsScript(windowTitle, maxDepth, maxElements, options?.fetchValues ?? false);
  const output = await runPS(script, timeoutMs);
  const result = JSON.parse(output);
  if (result.error) throw new Error(result.error);

  // Update cache if we know the hwnd
  if (options?.hwnd !== undefined) {
    try { updateUiaCache(options.hwnd, output); } catch { /* ignore */ }
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
  /** Normalised vertical position on the page (0 = top, 1 = bottom). Only filled by smart_scroll. */
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
): Promise<{ ok: boolean; element?: string; error?: string }> {
  // H3: hwnd-based lookup goes directly to PowerShell FromHandle path.
  // The Rust native path (uiaClickElement) does not accept hwnd, so we skip it
  // when hwnd is provided to ensure the hwnd-aware PS script is used.
  if (options?.hwnd === undefined && nativeUia?.uiaClickElement) {
    try {
      const result = await nativeUia.uiaClickElement({
        windowTitle,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
        controlType: controlType ?? undefined,
      });
      return { ok: result.ok, element: result.element ?? undefined, error: result.error ?? undefined };
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
): Promise<{ ok: boolean; error?: string }> {
  // H3: hwnd-based lookup skips Rust native (same reason as clickElement above).
  if (options?.hwnd === undefined && nativeUia?.uiaSetValue) {
    try {
      const result = await nativeUia.uiaSetValue({
        windowTitle,
        value,
        name: name ?? undefined,
        automationId: automationId ?? undefined,
      });
      return { ok: result.ok, error: result.error ?? undefined };
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
export async function getTextViaTextPattern(windowTitle: string, timeoutMs = 6000): Promise<string | null> {
  // ★ Rust native path (Phase C)
  if (nativeUia?.uiaGetTextViaTextPattern) {
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

$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"ok":false,"error":"Window not found"}'; exit }

# Collect ALL descendants with TextPattern, score by control-type preference
# (Document/Custom/Edit favored — these host the real terminal buffer) and
# fall back to the largest GetText payload. A naive "first match" picks the
# tab-title label in Windows Terminal and returns one line.
$candidates = [System.Collections.Generic.List[object]]::new()
$all = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    try {
        $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if ($null -ne $tp) {
            $ctName = ''
            try { $ctName = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.','' } catch {}
            $candidates.Add(@{ tp=$tp; controlType=$ctName })
        }
    } catch {}
}
# Also consider the root window itself
try {
    $rootTp = $target.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -ne $rootTp) { $candidates.Add(@{ tp=$rootTp; controlType='Window' }) }
} catch {}

if ($candidates.Count -eq 0) { Write-Output '{"ok":false,"error":"TextPattern not available"}'; exit }

function ControlTypeScore($ct) {
    switch -Regex ($ct) {
        '^(Document|Edit)$' { return 3 }
        '^Custom$'          { return 2 }
        '^(Pane|Group)$'    { return 1 }
        default             { return 0 }
    }
}

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
