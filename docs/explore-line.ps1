Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$nameProp = [System.Windows.Automation.AutomationElement]::NameProperty
$ctProp = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$desc = [System.Windows.Automation.TreeScope]::Descendants

$cond = New-Object System.Windows.Automation.PropertyCondition($nameProp, 'LINE')
$line = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)

if (-not $line) { Write-Output "LINE not found"; exit }

Write-Output ("Window: " + $line.Current.Name + " (" + $line.Current.ClassName + ")")
Write-Output ""

# Buttons
$btnCond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::Button)
$buttons = $line.FindAll($desc, $btnCond)
Write-Output ("--- Buttons (" + $buttons.Count + ") ---")
$i = 0
foreach ($b in $buttons) {
    if ($i -ge 15) { break }
    $c = $b.Current
    $r = $c.BoundingRectangle
    $loc = ""
    if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) {
        $loc = " at (" + [int]$r.X + "," + [int]$r.Y + " " + [int]$r.Width + "x" + [int]$r.Height + ")"
    }
    Write-Output ("  " + $c.Name + $loc)
    $i++
}

# Edit fields
$editCond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::Edit)
$edits = $line.FindAll($desc, $editCond)
Write-Output ""
Write-Output ("--- Edit fields (" + $edits.Count + ") ---")
foreach ($e in $edits) {
    $c = $e.Current
    $val = ""
    try {
        $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $val = $vp.Current.Value
    } catch { }
    $r = $c.BoundingRectangle
    $loc = ""
    if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) {
        $loc = " at (" + [int]$r.X + "," + [int]$r.Y + " " + [int]$r.Width + "x" + [int]$r.Height + ")"
    }
    Write-Output ("  Name='" + $c.Name + "' Value='" + $val + "'" + $loc)
}

# ListItems
$listCond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::ListItem)
$items = $line.FindAll($desc, $listCond)
Write-Output ""
Write-Output ("--- ListItems (" + $items.Count + ") ---")
$i = 0
foreach ($item in $items) {
    if ($i -ge 10) { Write-Output ("  ...and " + ($items.Count - $i) + " more"); break }
    Write-Output ("  " + $item.Current.Name)
    $i++
}

# Element type summary
$all = $line.FindAll($desc, $trueC)
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
