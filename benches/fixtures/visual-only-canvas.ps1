# benches/fixtures/visual-only-canvas.ps1
#
# ADR-024 Seed-2 S6 — self-contained visual-only (UIA-blind) canvas fixture for
# the round-trip bench (`benches/adr-024-seed2-roundtrip.mjs`) and the headed-
# gated e2e (`tests/e2e/desktop-act-roi-capture.test.ts`).
#
# WHAT: a Form whose entire client area is one full-bleed, custom-painted Panel
# (UIA "Pane" + only-child => single-giant-pane / too-few-elements =>
# uiaBlindForOcr fires => the visual-only regime that roiCapture targets). The
# only readable content is OCR text ("TARGET ALPHA" / "ZONE BETA"), so
# desktop_discover surfaces OCR entities (no UIA controls).
#
# WHY THE TOGGLE BAR (vs the dogfood canvas's cumulative crimson): the bench
# clicks the SAME OCR anchors across many iterations. If a click painted over the
# text, the next discover could no longer find the anchor. Instead each anchor has
# a thin highlight bar just BELOW its (always-readable, black-on-white) text;
# clicking an anchor TOGGLES that bar crimson<->white. This yields a *fresh,
# localized* repaint at the click point on every click while the OCR text always
# survives — repeatable for N iterations. The bar sits within ~96px of the click
# centre so it lands inside the local-repaint SSIM crop (a localized ROI, never
# full-window).
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File visual-only-canvas.ps1 -Title <name>
param([string]$Title)

# Hide the PowerShell host console so only the form is visible (same trick as
# tests/e2e/helpers/blank-window.ts — do NOT use -WindowStyle Hidden, that hides
# the form too; do NOT use a detached process, a detached GUI exits immediately).
$sig = '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h,int n);'
$native = Add-Type -MemberDefinition $sig -Name CanvasNative -PassThru
[void]$native::ShowWindow($native::GetConsoleWindow(), 0)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$W = 800; $H = 600

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
# Centre the window — NOT the top-left corner. A previous Point(40, 40) placement
# put this window's title bar directly over the Recycle Bin / desktop-icon zone
# (icons live at the screen's top-left edge), so a real OS click that grazed the
# title bar — or the brief spawn/close moment when the desktop is exposed under
# the TopMost form — selected the Recycle Bin instead. This is the same hazard
# tests/e2e/helpers/blank-window.ts documents (a (50,50) click "selected the
# Recycle Bin desktop icon at every full-suite run"). CenterScreen keeps the whole
# window clear of the edge/corner icons on any resolution. We don't need the old
# "no overlapping background" rationale: busy-background correctness is handled
# structurally by the S5c frame-diff regime (occlusion-immune PrintWindow).
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size($W, $H)
$form.TopMost = $true

# Backing bitmap (client-sized) — the single source of pixels for the panel.
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$bigFont = New-Object System.Drawing.Font('Segoe UI', 34, [System.Drawing.FontStyle]::Bold)

# Two anchors: text (always black-on-white, always OCR-readable) + a toggle bar
# just below it. Bar toggles crimson<->white on each click of that anchor.
$script:state = @{ ALPHA = $false; BETA = $false }
$anchors = @(
  @{ Key = 'ALPHA'; Text = 'TARGET ALPHA'; TextY = 70;  BarY = 120 },
  @{ Key = 'BETA';  Text = 'ZONE BETA';    TextY = 380; BarY = 430 }
)
$BarX = 60; $BarW = 300; $BarH = 22

function Repaint-Anchor($a) {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # Clear the anchor band (text + bar) to white, then redraw text on top and the
  # toggle bar in its current colour.
  $g.FillRectangle([System.Drawing.Brushes]::White, 40, ($a.TextY - 8), ($W - 80), 110)
  $g.DrawString($a.Text, $bigFont, [System.Drawing.Brushes]::Black, 60, $a.TextY)
  $on = $script:state[$a.Key]
  $barBrush = if ($on) { [System.Drawing.Brushes]::Crimson } else { [System.Drawing.Brushes]::White }
  $g.FillRectangle($barBrush, $BarX, $a.BarY, $BarW, $BarH)
  $g.Dispose()
}

# Initial paint: white background + both anchors (bars off = white).
$g0 = [System.Drawing.Graphics]::FromImage($bmp)
$g0.Clear([System.Drawing.Color]::White)
$g0.Dispose()
foreach ($a in $anchors) { Repaint-Anchor $a }

$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
# Enable double-buffering on the panel via reflection (DoubleBuffered is protected).
$panel.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic).SetValue($panel, $true, $null)

$panel.Add_Paint({
  param($s, $e)
  $e.Graphics.DrawImageUnscaled($bmp, 0, 0)
}.GetNewClosure())

$panel.Add_MouseClick({
  param($s, $e)
  # Pick the nearer anchor by Y; toggle its bar and repaint just that band so the
  # change is localized to the click point.
  $a = if ($e.Y -lt 300) { $anchors[0] } else { $anchors[1] }
  $script:state[$a.Key] = -not $script:state[$a.Key]
  Repaint-Anchor $a
  $s.Invalidate((New-Object System.Drawing.Rectangle(40, ($a.TextY - 8), ($W - 80), 110)))
}.GetNewClosure())

$form.Controls.Add($panel)
$form.Add_Shown({ $form.Activate() })
[System.Windows.Forms.Application]::Run($form)
