[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
$target = $null
foreach ($w in $allWins) {
    if ($w.Current.ClassName -eq 'MSPaintApp') { $target = $w; break }
}
if (-not $target) { Write-Output 'Paint NOT FOUND'; exit }
Write-Output ('Found: ' + $target.Current.Name)

$cvWalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$cacheReq = [System.Windows.Automation.CacheRequest]::new()
$cacheReq.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
$cacheReq.Add([System.Windows.Automation.AutomationElement]::NameProperty)
$cacheReq.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
$cacheReq.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
$cacheReq.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
$cacheReq.Add([System.Windows.Automation.InvokePattern]::Pattern)

$results = [System.Collections.Generic.List[object]]::new()
$count = 0
$maxElements = 50
$maxDepth = 4

$scope = $cacheReq.Activate()
try {
    $stack = [System.Collections.Generic.Stack[object]]::new()
    $first = $cvWalker.GetFirstChild($target)
    if ($null -ne $first) { $stack.Push(@{ el=$first; depth=0 }) }

    while ($stack.Count -gt 0 -and $count -lt $maxElements) {
        $item  = $stack.Pop()
        $el    = $item.el
        $depth = $item.depth

        try {
            $next = $cvWalker.GetNextSibling($el)
            if ($null -ne $next) { $stack.Push(@{ el=$next; depth=$depth }) }
        } catch {}

        $offscreen = $false
        try { $offscreen = $el.GetCachedPropertyValue([System.Windows.Automation.AutomationElement]::IsOffscreenProperty) } catch {}
        if ($offscreen -eq $true) { continue }

        $name = ''
        try { $name = $el.CachedName } catch {}
        $ct = ''
        try { $ct = $el.CachedControlType.ProgrammaticName -replace 'ControlType\.', '' } catch {}
        $r = $el.CachedBoundingRectangle
        $hasInvoke = $false
        try { $null = $el.GetCachedPattern([System.Windows.Automation.InvokePattern]::Pattern); $hasInvoke = $true } catch {}

        Write-Output ('  [' + $depth + '] ' + $ct + ' name="' + $name + '" Offscreen=' + $offscreen + ' Invoke=' + $hasInvoke + ' rect=' + [int]$r.X + ',' + [int]$r.Y)
        $count++

        if ($depth -lt $maxDepth) {
            try {
                $child = $cvWalker.GetFirstChild($el)
                if ($null -ne $child) { $stack.Push(@{ el=$child; depth=($depth+1) }) }
            } catch {}
        }
    }
} finally {
    $scope.Dispose()
}
Write-Output ('Total elements: ' + $count)
