import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  maxElements: number
): string {
  const safeTitle = escapeLike(windowTitle);
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$ctProp = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$trueC  = [System.Windows.Automation.Condition]::TrueCondition
$desc   = [System.Windows.Automation.TreeScope]::Descendants

# Find window by partial title
$target = $null
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
foreach ($w in $allWins) {
    if ($w.Current.Name -like '*${safeTitle}*') { $target = $w; break }
}
if (-not $target) { Write-Output '{"error":"Window not found"}'; exit }

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

Collect $target 0
$output = @{ windowTitle=$target.Current.Name; elementCount=$results.Count; elements=$results.ToArray() }
$output | ConvertTo-Json -Depth 6 -Compress
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

try {
    $ip = $found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
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
  isEnabled: boolean;
  boundingRect: { x: number; y: number; width: number; height: number } | null;
  patterns: string[];
  depth: number;
}

export interface UiElementsResult {
  windowTitle: string;
  elementCount: number;
  elements: UiElement[];
}

export async function getUiElements(
  windowTitle: string,
  maxDepth = 3,
  maxElements = 50,
  timeoutMs = 10000
): Promise<UiElementsResult> {
  const script = makeGetElementsScript(windowTitle, maxDepth, maxElements);
  const output = await runPS(script, timeoutMs);
  const result = JSON.parse(output);
  if (result.error) throw new Error(result.error);
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
}

export interface TextContent {
  content: string;
  /** Top-left of the text element in screen coordinates. */
  at: { x: number; y: number };
}

export interface ActionableResult {
  window: string;
  windowRegion?: { x: number; y: number; width: number; height: number };
  /** Interactive elements sorted by screen position (top→bottom, left→right). */
  actionable: ActionableElement[];
  /** Static text labels extracted from Text/Pane elements. */
  texts: TextContent[];
}

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

    const action = deriveAction(el.patterns, el.controlType);
    if (!action) continue;

    const label = el.name || el.automationId || el.controlType;
    if (!label) continue;

    const item: ActionableElement = {
      action,
      name: label,
      type: el.controlType,
      clickAt,
      region: { x: r.x, y: r.y, width: r.width, height: r.height },
    };

    if (el.automationId) item.id = el.automationId;
    if (!el.isEnabled) item.enabled = false;

    actionable.push(item);
  }

  // Sort by vertical position, then horizontal
  actionable.sort((a, b) =>
    a.region.y !== b.region.y ? a.region.y - b.region.y : a.region.x - b.region.x
  );

  // Find window root region (depth=0 Window element)
  const windowEl = result.elements.find((e) => e.controlType === "Window");
  const windowRegion = windowEl?.boundingRect ?? undefined;

  return {
    window: result.windowTitle,
    windowRegion: windowRegion ?? undefined,
    actionable,
    texts,
  };
}

export async function clickElement(
  windowTitle: string,
  name?: string,
  automationId?: string,
  controlType?: string
): Promise<{ ok: boolean; element?: string; error?: string }> {
  const script = makeClickElementScript(windowTitle, name, automationId, controlType);
  const output = await runPS(script, 8000);
  return JSON.parse(output);
}

export async function setElementValue(
  windowTitle: string,
  value: string,
  name?: string,
  automationId?: string
): Promise<{ ok: boolean; error?: string }> {
  const script = makeSetValueScript(windowTitle, name, automationId, value);
  const output = await runPS(script, 8000);
  return JSON.parse(output);
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
  const script = makeGetChildrenScript(windowTitle, name, automationId, controlType, maxDepth, maxElements);
  const output = await runPS(script, timeoutMs);
  const result = JSON.parse(output);
  if (result.error) throw new Error(result.error);
  return (result.elements ?? []) as UiElement[];
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
