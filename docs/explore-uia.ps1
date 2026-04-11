[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement

# --- 1. 全ウィンドウとサポートパターンを列挙 ---
Write-Output "=== 開いているウィンドウ一覧 ==="
$cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)

foreach ($w in $windows) {
    $c = $w.Current
    if ($c.Name -ne '') {
        $patterns = ($w.GetSupportedPatterns() | ForEach-Object {
            $_.ProgrammaticName -replace 'Identifiers\.Pattern',''
        }) -join ', '
        $r = $c.BoundingRectangle
        $rectStr = 'off-screen'
        if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) {
            $rectStr = "($([int]$r.X),$([int]$r.Y) $([int]$r.Width)x$([int]$r.Height))"
        }
        Write-Output "  [$($c.ClassName)] $($c.Name) $rectStr"
        Write-Output "    Patterns: $patterns"
    }
}

# --- 2. 特定ウィンドウ（Edge）のUI要素を深く探索 ---
Write-Output ""
Write-Output "=== Edge ブラウザのUI要素ツリー（深さ2） ==="

$target = $null
foreach ($w in $windows) {
    $cls = $w.Current.ClassName
    if ($cls -match 'Chrome_WidgetWin') {
        $target = $w
        break
    }
}

function Walk-Element($el, $depth, $maxDepth) {
    if ($depth -gt $maxDepth) { return }
    $c = $el.Current
    $r = $c.BoundingRectangle
    $patterns = ($el.GetSupportedPatterns() | ForEach-Object {
        $_.ProgrammaticName -replace 'Identifiers\.Pattern',''
    }) -join ', '

    $rectStr = ''
    if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) {
        $rectStr = "($([int]$r.X),$([int]$r.Y) $([int]$r.Width)x$([int]$r.Height))"
    }

    $type = $c.ControlType.ProgrammaticName -replace 'ControlType\.',''
    $indent = '  ' * $depth
    $info = "${indent}[${type}] Name='$($c.Name)' AutoId='$($c.AutomationId)' $rectStr"
    if ($patterns) { $info += " | $patterns" }
    Write-Output $info

    $children = $el.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $count = 0
    foreach ($child in $children) {
        if ($count -ge 8) {
            Write-Output "${indent}  ...($($children.Count - $count) more children)"
            break
        }
        Walk-Element $child ($depth + 1) $maxDepth
        $count++
    }
}

if ($target) {
    Write-Output "Target: $($target.Current.Name)"
    Walk-Element $target 0 2
} else {
    Write-Output "Edge window not found, trying first available window..."
    $first = $null
    foreach ($w in $windows) {
        if ($w.Current.Name -ne '' -and $w.Current.Name -ne 'Program Manager') {
            $first = $w
            break
        }
    }
    if ($first) {
        Write-Output "Target: $($first.Current.Name)"
        Walk-Element $first 0 2
    }
}

# --- 3. ValuePattern のデモ: テキスト要素の値を読み取る ---
Write-Output ""
Write-Output "=== ValuePattern デモ: テキスト入力欄を検索 ==="

if ($target) {
    $editCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit
    )
    $edits = $target.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
    $editCount = 0
    foreach ($edit in $edits) {
        if ($editCount -ge 5) { break }
        $ec = $edit.Current
        $val = ''
        try {
            $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $val = $vp.Current.Value
        } catch {}
        $r = $ec.BoundingRectangle
        $rectStr = ''
        if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) {
            $rectStr = "($([int]$r.X),$([int]$r.Y) $([int]$r.Width)x$([int]$r.Height))"
        }
        Write-Output "  Edit: Name='$($ec.Name)' Value='$val' $rectStr"
        $editCount++
    }
    if ($editCount -eq 0) {
        Write-Output "  (Edit要素が見つかりませんでした)"
    }
}

# --- 4. InvokePattern デモ: クリック可能なボタンを検索 ---
Write-Output ""
Write-Output "=== InvokePattern デモ: ボタン一覧 ==="

if ($target) {
    $btnCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
    )
    $buttons = $target.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    $btnCount = 0
    foreach ($btn in $buttons) {
        if ($btnCount -ge 10) { Write-Output "  ...($($buttons.Count - $btnCount) more buttons)"; break }
        $bc = $btn.Current
        $canInvoke = $false
        try {
            $null = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $canInvoke = $true
        } catch {}
        $r = $bc.BoundingRectangle
        $rectStr = ''
        if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) {
            $rectStr = "($([int]$r.X),$([int]$r.Y) $([int]$r.Width)x$([int]$r.Height))"
        }
        Write-Output "  Button: Name='$($bc.Name)' Invokable=$canInvoke $rectStr"
        $btnCount++
    }
}
