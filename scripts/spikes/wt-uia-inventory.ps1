# wt-uia-inventory.ps1
#
# Spike: TermControl の writable UIA pattern inventory (= ADR-013 §3.2 Option B Phase 1 inventory)
# 結果: 2026-05-10 実機検証で TermControl が TextPattern のみ実装、ValuePattern 含め
#       writable pattern は一切実装されていないことを確認。Option B = NO-GO 確定。
#
# 詳細結果: docs/wt-bg-spike-round2-findings.md §1.A "Option B UIA inventory NEGATIVE"

[CmdletBinding()]
param([int]$LaunchSettleMs = 1500)

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue

$wtName = "spike-uia-$([guid]::NewGuid().ToString('N').Substring(0,6))"
$titleTag = "DTM_UIA_INV_$([guid]::NewGuid().ToString('N').Substring(0,8))"

Start-Process wt.exe -ArgumentList @('-w', $wtName, 'new-tab', '--title', $titleTag, '--', 'powershell.exe', '-NoLogo', '-NoExit')
Start-Sleep -Milliseconds $LaunchSettleMs

$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
$wt = $null
foreach ($w in $wins) { if ($w.Current.Name -like "*$titleTag*") { $wt = $w; break } }
if (-not $wt) { Write-Error "WT window not found"; exit 1 }

$desc = [System.Windows.Automation.TreeScope]::Descendants
$els = $wt.FindAll($desc, $trueC)
$pats = @(
  @{Name='ValuePattern';        Pattern=[System.Windows.Automation.ValuePattern]::Pattern},
  @{Name='TextPattern';         Pattern=[System.Windows.Automation.TextPattern]::Pattern},
  @{Name='InvokePattern';       Pattern=[System.Windows.Automation.InvokePattern]::Pattern},
  @{Name='SelectionPattern';    Pattern=[System.Windows.Automation.SelectionPattern]::Pattern},
  @{Name='RangeValuePattern';   Pattern=[System.Windows.Automation.RangeValuePattern]::Pattern},
  @{Name='SelectionItemPattern'; Pattern=[System.Windows.Automation.SelectionItemPattern]::Pattern},
  @{Name='ScrollPattern';       Pattern=[System.Windows.Automation.ScrollPattern]::Pattern},
  @{Name='WindowPattern';       Pattern=[System.Windows.Automation.WindowPattern]::Pattern},
  @{Name='ExpandCollapsePattern'; Pattern=[System.Windows.Automation.ExpandCollapsePattern]::Pattern}
)

$results = @()
foreach ($el in $els) {
  $supportedPats = @()
  foreach ($p in $pats) {
    try { $obj = $el.GetCurrentPattern($p.Pattern); if ($obj) { $supportedPats += $p.Name } } catch {}
  }
  $cls = $el.Current.ClassName
  if ($cls -like '*Term*' -or $cls -like '*Control*' -or $supportedPats.Count -ge 1) {
    $results += [PSCustomObject]@{
      ControlType = $el.Current.ControlType.ProgrammaticName
      ClassName = $cls
      Name = $el.Current.Name
      Patterns = $supportedPats -join ','
    }
  }
}

$results | Format-Table -AutoSize | Out-String | Write-Host

# Cleanup controlled WT
Get-Process -Name 'WindowsTerminal','OpenConsole','powershell','pwsh' -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
    if ($cmdLine -like "*$wtName*" -or $cmdLine -like "*$titleTag*") {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}
