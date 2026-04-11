Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$ctProp = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$clsProp = [System.Windows.Automation.AutomationElement]::ClassNameProperty
$desc = [System.Windows.Automation.TreeScope]::Descendants
$trueC = [System.Windows.Automation.Condition]::TrueCondition

# Find Explorer window
$clsCond = New-Object System.Windows.Automation.PropertyCondition($clsProp, 'CabinetWClass')
$explorer = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $clsCond)

if (-not $explorer) { Write-Output "Explorer not found"; exit }

Write-Output ("Window: " + $explorer.Current.Name)
Write-Output ""

# --- ツールバーボタン ---
$btnCond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::Button)
$buttons = $explorer.FindAll($desc, $btnCond)
Write-Output ("--- Toolbar Buttons (" + $buttons.Count + ") ---")
$i = 0
foreach ($b in $buttons) {
    if ($i -ge 20) { Write-Output ("  ...and " + ($buttons.Count - $i) + " more"); break }
    $c = $b.Current
    $canInvoke = $false
    try { $null = $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $canInvoke = $true } catch { }
    $r = $c.BoundingRectangle
    $loc = ""
    if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) {
        $loc = " at (" + [int]$r.X + "," + [int]$r.Y + ")"
    }
    if ($c.Name -ne '') {
        Write-Output ("  [Button] '" + $c.Name + "' Invoke=" + $canInvoke + $loc)
    }
    $i++
}

# --- アドレスバー / Edit ---
$editCond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::Edit)
$edits = $explorer.FindAll($desc, $editCond)
Write-Output ""
Write-Output ("--- Edit fields (" + $edits.Count + ") ---")
foreach ($e in $edits) {
    $c = $e.Current
    $val = ""
    try {
        $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $val = $vp.Current.Value
    } catch { }
    Write-Output ("  Name='" + $c.Name + "' Value='" + $val + "'")
}

# --- TreeItem (フォルダツリー) ---
$treeCond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::TreeItem)
$treeItems = $explorer.FindAll($desc, $treeCond)
Write-Output ""
Write-Output ("--- TreeItems - folder nav (" + $treeItems.Count + ") ---")
$i = 0
foreach ($t in $treeItems) {
    if ($i -ge 10) { Write-Output ("  ...and " + ($treeItems.Count - $i) + " more"); break }
    $c = $t.Current
    $pats = ($t.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'Identifiers\.Pattern','' }) -join ', '
    Write-Output ("  '" + $c.Name + "' | " + $pats)
    $i++
}

# --- ファイルリスト (ListItem / DataItem) ---
$listCond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::ListItem)
$listItems = $explorer.FindAll($desc, $listCond)
$dataCond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::DataItem)
$dataItems = $explorer.FindAll($desc, $dataCond)
Write-Output ""
Write-Output ("--- File list (ListItem:" + $listItems.Count + " DataItem:" + $dataItems.Count + ") ---")
$items = if ($listItems.Count -gt 0) { $listItems } else { $dataItems }
$i = 0
foreach ($item in $items) {
    if ($i -ge 10) { Write-Output ("  ...and more"); break }
    $c = $item.Current
    $pats = ($item.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'Identifiers\.Pattern','' }) -join ', '
    Write-Output ("  '" + $c.Name + "' | " + $pats)
    $i++
}

# --- Element summary ---
$all = $explorer.FindAll($desc, $trueC)
Write-Output ""
Write-Output ("--- Element types (total: " + $all.Count + ") ---")
$types = @{}
foreach ($el in $all) {
    $t = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''
    if ($types.ContainsKey($t)) { $types[$t]++ } else { $types[$t] = 1 }
}
foreach ($kv in $types.GetEnumerator() | Sort-Object Value -Descending) {
    Write-Output ("  " + $kv.Key + ": " + $kv.Value)
}
