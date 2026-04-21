import { spawn, ChildProcess } from "node:child_process";

export interface TrayOptions {
  /** HTTP URL to display in the tray (e.g. http://127.0.0.1:23847/mcp) */
  httpUrl?: string;
  /** Path to custom .ico file. Falls back to SystemIcons::Application if not provided. */
  icoPath?: string;
  /** Server version string for About dialog and tooltip */
  version?: string;
  /** Called when the tray explicitly requests that the parent process exit. */
  onExitRequested?: () => void;
}

function escapePs(s: string): string {
  return s.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

function buildTrayScript(options: TrayOptions): string {
  const version = options.version ?? "";

  const icoBlock = options.icoPath
    ? [
        `$icoPath = '${escapePs(options.icoPath)}'`,
        `if (Test-Path -LiteralPath $icoPath) {`,
        `    $icon.Icon = [System.Drawing.Icon]::new($icoPath)`,
        `} else {`,
        `    $icon.Icon = [System.Drawing.SystemIcons]::Application`,
        `}`,
      ].join("\n")
    : `$icon.Icon = [System.Drawing.SystemIcons]::Application`;

  const header = [
    `Add-Type -AssemblyName System.Windows.Forms`,
    `Add-Type -AssemblyName System.Drawing`,
    ``,
    `$icon = New-Object System.Windows.Forms.NotifyIcon`,
    icoBlock,
  ].join("\n");

  const footer = [
    `[Console]::Out.WriteLine('READY')`,
    `[Console]::Out.Flush()`,
    ``,
    `[System.Windows.Forms.Application]::Run()`,
  ].join("\n");

  const aboutBody = [
    `    [System.Windows.Forms.MessageBox]::Show(`,
    `        "Desktop Touch MCP\`nVersion: ${version}",`,
    `        "Desktop Touch MCP",`,
    `        [System.Windows.Forms.MessageBoxButtons]::OK,`,
    `        [System.Windows.Forms.MessageBoxIcon]::Information`,
    `    ) | Out-Null`,
  ].join("\n");

  const exitBody = [
    `    [Console]::Out.WriteLine('EXIT')`,
    `    [Console]::Out.Flush()`,
    `    $icon.Visible = $false`,
    `    $icon.Dispose()`,
    `    [System.Windows.Forms.Application]::Exit()`,
    `    Stop-Process -Id $PID -Force`,
  ].join("\n");

  if (options.httpUrl) {
    const url = options.httpUrl.replace(/'/g, "''");
    const aboutBodyHttp = [
      `    [System.Windows.Forms.MessageBox]::Show(`,
      `        "Desktop Touch MCP\`nVersion: ${version}\`nHTTP: ${options.httpUrl}",`,
      `        "Desktop Touch MCP",`,
      `        [System.Windows.Forms.MessageBoxButtons]::OK,`,
      `        [System.Windows.Forms.MessageBoxIcon]::Information`,
      `    ) | Out-Null`,
    ].join("\n");

    const lines = [
      header,
      `$icon.Text = "Desktop Touch MCP v${version} (HTTP)"`,
      `$icon.Visible = $true`,
      ``,
      `$menu = New-Object System.Windows.Forms.ContextMenuStrip`,
      ``,
      `$urlItem = $menu.Items.Add('HTTP: ${url}')`,
      `$urlItem.Enabled = $false`,
      `$menu.Items.Add('-') | Out-Null`,
      ``,
      `$copyItem = $menu.Items.Add('URL をコピー')`,
      `$copyItem.add_Click({`,
      `    [System.Windows.Forms.Clipboard]::SetText('${url}')`,
      `})`,
      ``,
      `$openItem = $menu.Items.Add('ブラウザで開く (health)')`,
      `$openItem.add_Click({`,
      `    Start-Process '${options.httpUrl!.replace(/\/mcp$/, "/health")}'`,
      `})`,
      `$menu.Items.Add('-') | Out-Null`,
      ``,
      `$aboutItem = $menu.Items.Add('About (v${version})')`,
      `$aboutItem.add_Click({`,
      aboutBodyHttp,
      `})`,
      `$menu.Items.Add('-') | Out-Null`,
      ``,
      `$exitItem = $menu.Items.Add('終了')`,
      `$exitItem.add_Click({`,
      exitBody,
      `})`,
      `$icon.ContextMenuStrip = $menu`,
      ``,
      `$icon.BalloonTipTitle = 'Desktop Touch MCP'`,
      `$icon.BalloonTipText = "HTTP モードで起動中\`n${options.httpUrl}"`,
      `$icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info`,
      ``,
      footer,
      `$icon.ShowBalloonTip(4000)`,
      ``,
      `[System.Windows.Forms.Application]::Run()`,
    ];

    // Remove duplicate Run() from footer
    return lines.slice(0, -3).join("\n") + "\n" + [
      `[Console]::Out.WriteLine('READY')`,
      `[Console]::Out.Flush()`,
      ``,
      `$icon.ShowBalloonTip(4000)`,
      ``,
      `[System.Windows.Forms.Application]::Run()`,
    ].join("\n");
  }

  // stdio mode
  return [
    header,
    `$icon.Text = 'Desktop Touch MCP v${version}'`,
    `$icon.Visible = $true`,
    ``,
    `$menu = New-Object System.Windows.Forms.ContextMenuStrip`,
    ``,
    `$aboutItem = $menu.Items.Add('About (v${version})')`,
    `$aboutItem.add_Click({`,
    aboutBody,
    `})`,
    `$menu.Items.Add('-') | Out-Null`,
    ``,
    `$exitItem = $menu.Items.Add('終了')`,
    `$exitItem.add_Click({`,
    exitBody,
    `})`,
    `$icon.ContextMenuStrip = $menu`,
    ``,
    footer,
  ].join("\n");
}

let trayProcess: ChildProcess | null = null;

export function createTrayMessageParser(
  onMessage: (message: string) => void
): (chunk: string | Buffer) => void {
  let pending = "";
  return (chunk: string | Buffer) => {
    pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex = pending.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex).trim();
      pending = pending.slice(newlineIndex + 1);
      if (line) onMessage(line);
      newlineIndex = pending.indexOf("\n");
    }
  };
}

/** Start the system tray icon in a background PowerShell process */
export function startTray(options: TrayOptions = {}): void {
  try {
    const script = buildTrayScript(options);
    trayProcess = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        stdio: ["ignore", "pipe", "ignore"],
        detached: false,
      }
    );

    const parseStdout = createTrayMessageParser((msg) => {
      if (msg === "READY") {
        console.error("[tray] System tray icon active");
        return;
      }
      if (msg === "EXIT") {
        console.error("[tray] Exit requested from tray");
        options.onExitRequested?.();
      }
    });

    trayProcess.stdout?.on("data", parseStdout);

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
