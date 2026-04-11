import { spawn, ChildProcess } from "node:child_process";

const TRAY_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = 'Desktop Touch MCP - Running'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$exitItem = $menu.Items.Add('Exit MCP Server')
$exitItem.add_Click({
    $icon.Visible = $false
    $icon.Dispose()
    [System.Windows.Forms.Application]::Exit()
    Stop-Process -Id $PID -Force
})
$icon.ContextMenuStrip = $menu
$icon.add_BalloonTipClicked({ })

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

[System.Windows.Forms.Application]::Run()
`;

let trayProcess: ChildProcess | null = null;

/** Start the system tray icon in a background PowerShell process */
export function startTray(): void {
  try {
    trayProcess = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", TRAY_SCRIPT],
      {
        stdio: ["ignore", "pipe", "ignore"],
        detached: false,
      }
    );

    trayProcess.stdout?.once("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg === "READY") {
        console.error("[tray] System tray icon active");
      }
    });

    trayProcess.on("exit", (code) => {
      console.error(`[tray] Tray process exited (code ${code})`);
      trayProcess = null;
    });

    trayProcess.on("error", (err) => {
      console.error(`[tray] Tray process error: ${err.message}`);
      trayProcess = null;
    });
  } catch (err) {
    // Tray is non-critical — log and continue
    console.error(`[tray] Failed to start tray: ${String(err)}`);
  }
}

/** Stop the system tray icon */
export function stopTray(): void {
  if (trayProcess && !trayProcess.killed) {
    try {
      trayProcess.kill("SIGTERM");
    } catch {
      // Ignore
    }
    trayProcess = null;
  }
}
