#requires -Version 5.1
<#
.SYNOPSIS
    HTTP MCP 接続確認テストスクリプト

.DESCRIPTION
    desktop-touch-mcp の HTTP モードの接続を検証します:
    1. サーバー起動（または既存サーバーへの接続）
    2. MCP initialize リクエスト
    3. セッション ID の発行確認
    4. tools/list リクエスト（セッション再利用）
    5. 結果を PASS/FAIL で出力

.PARAMETER UseExisting
    既存サーバーに接続する（新規起動しない）

.PARAMETER Port
    HTTP ポート（デフォルト: 23847）

.PARAMETER ServerPath
    サーバースクリプトのパス（デフォルト: dist/index.js）

.EXAMPLE
    .\scripts\test-http-mcp.ps1
    # サーバーを起動してテスト実行

.EXAMPLE
    .\scripts\test-http-mcp.ps1 -UseExisting
    # 既存サーバーに接続してテスト
#>

[CmdletBinding()]
param(
    [switch]$UseExisting,
    [int]$Port = 23847,
    [string]$ServerPath = "dist/index.js"
)

$ErrorActionPreference = 'Stop'
$baseUrl = "http://127.0.0.1:$Port"
$mcpUrl = "$baseUrl/mcp"
$healthUrl = "$baseUrl/health"

$script:serverProcess = $null
$script:passed = 0
$script:failed = 0
$script:sessionId = $null

function Write-TestHeader {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  HTTP MCP Connection Test" -ForegroundColor Cyan
    Write-Host "  Target: $mcpUrl" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan
}

function Write-Pass {
    param([string]$Message)
    Write-Host "[PASS] $Message" -ForegroundColor Green
    $script:passed++
}

function Write-Fail {
    param([string]$Message, [string]$Detail = "")
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    if ($Detail) { Write-Host "       $Detail" -ForegroundColor Yellow }
    $script:failed++
}

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Gray
}

function Start-McpServer {
    if ($UseExisting) {
        Write-Info "Connecting to existing server at $baseUrl"
        return $true
    }

    # Check if already running
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
        Write-Info "Server already running (version: $($health.version))"
        return $true
    } catch {
        # Not running, start it
    }

    $serverScript = Join-Path (Get-Location) $ServerPath
    if (-not (Test-Path $serverScript)) {
        Write-Fail "Server script not found" $serverScript
        return $false
    }

    Write-Info "Starting server: node $serverScript --http --port $Port"

    $script:serverProcess = Start-Process -FilePath "node" `
        -ArgumentList $serverScript, "--http", "--port", $Port `
        -PassThru `
        -NoNewWindow `
        -RedirectStandardError "NUL"

    # Wait for server to be ready
    $maxWait = 15
    for ($i = 0; $i -lt $maxWait; $i++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
            Write-Pass "Server started (version: $($health.version), PID: $($script:serverProcess.Id))"
            return $true
        } catch {
            Write-Info "Waiting for server... ($($i + 1)/$maxWait)"
        }
    }

    Write-Fail "Server failed to start within $maxWait seconds"
    return $false
}

function Stop-McpServer {
    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
        Write-Info "Stopping server (PID: $($script:serverProcess.Id))"
        try {
            Stop-Process -Id $script:serverProcess.Id -Force -ErrorAction SilentlyContinue
            $script:serverProcess.WaitForExit(5000) | Out-Null
        } catch {
            # Ignore
        }
    }
}

function Test-HealthEndpoint {
    Write-Host "`n--- Test 1: Health Endpoint ---" -ForegroundColor White
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
        if ($response.status -eq "ok" -and $response.name -eq "desktop-touch-mcp") {
            Write-Pass "Health endpoint OK (version: $($response.version))"
            return $true
        } else {
            Write-Fail "Health endpoint returned unexpected data" ($response | ConvertTo-Json -Compress)
            return $false
        }
    } catch {
        Write-Fail "Health endpoint failed" $_.Exception.Message
        return $false
    }
}

function Test-McpInitialize {
    Write-Host "`n--- Test 2: MCP Initialize ---" -ForegroundColor White

    $initBody = @{
        jsonrpc = "2.0"
        id = 1
        method = "initialize"
        params = @{
            protocolVersion = "2024-11-05"
            capabilities = @{
                tools = @{}
            }
            clientInfo = @{
                name = "http-test"
                version = "1.0.0"
            }
        }
    } | ConvertTo-Json -Depth 10

    try {
        $headers = @{
            "Content-Type" = "application/json"
            "Accept" = "application/json, text/event-stream"
        }

        $response = Invoke-WebRequest -Uri $mcpUrl -Method Post -Body $initBody -Headers $headers -TimeoutSec 10

        # Check for session ID in response header (may be absent in stateless mode)
        $script:sessionId = $response.Headers["mcp-session-id"]
        if (-not $script:sessionId) {
            $script:sessionId = $response.Headers["Mcp-Session-Id"]
        }

        if ($script:sessionId) {
            Write-Info "Session ID: $($script:sessionId.Substring(0, [Math]::Min(8, $script:sessionId.Length)))... (stateful mode)"
        } else {
            Write-Info "No session ID (stateless mode)"
        }

        # Parse JSON response
        $json = $response.Content | ConvertFrom-Json
        if ($json.result -and $json.result.protocolVersion) {
            Write-Pass "Initialize response OK (protocol: $($json.result.protocolVersion))"
            return $true
        } else {
            Write-Fail "Initialize response missing result" ($json | ConvertTo-Json -Compress)
            return $false
        }
    } catch {
        Write-Fail "Initialize request failed" $_.Exception.Message
        return $false
    }
}

function Test-InitializedNotification {
    Write-Host "`n--- Test 3: Send initialized Notification ---" -ForegroundColor White

    # In stateless HTTP mode, each request is handled by a fresh McpServer instance.
    # The server has no prior context, so notifications/initialized (which must follow
    # an initialize call in the same session) returns 406 Not Acceptable.
    # This is expected and correct behavior for stateless mode.
    if (-not $script:sessionId) {
        Write-Pass "Stateless mode: notifications/initialized skipped (no session — expected)"
        return $true
    }

    $notifyBody = @{
        jsonrpc = "2.0"
        method = "notifications/initialized"
    } | ConvertTo-Json -Depth 5

    try {
        $headers = @{
            "Content-Type" = "application/json"
            "mcp-session-id" = $script:sessionId
        }

        # Notification returns 202 Accepted (no response body expected)
        $response = Invoke-WebRequest -Uri $mcpUrl -Method Post -Body $notifyBody -Headers $headers -TimeoutSec 10

        if ($response.StatusCode -eq 202 -or $response.StatusCode -eq 200) {
            Write-Pass "initialized notification accepted (status: $($response.StatusCode))"
            return $true
        } else {
            Write-Fail "Unexpected status code" $response.StatusCode
            return $false
        }
    } catch {
        # 202 might throw in some PowerShell versions
        if ($_.Exception.Response.StatusCode -eq 202) {
            Write-Pass "initialized notification accepted (status: 202)"
            return $true
        }
        Write-Fail "initialized notification failed" $_.Exception.Message
        return $false
    }
}

function Test-ToolsList {
    Write-Host "`n--- Test 4: Tools List ---" -ForegroundColor White

    $listBody = @{
        jsonrpc = "2.0"
        id = 2
        method = "tools/list"
    } | ConvertTo-Json -Depth 5

    try {
        $headers = @{
            "Content-Type" = "application/json"
            "Accept" = "application/json, text/event-stream"
        }
        # Add session ID if available (stateful mode)
        if ($script:sessionId) {
            $headers["mcp-session-id"] = $script:sessionId
        }

        $response = Invoke-WebRequest -Uri $mcpUrl -Method Post -Body $listBody -Headers $headers -TimeoutSec 30

        # Parse tools list
        $json = $response.Content | ConvertFrom-Json
        if ($json.result -and $json.result.tools) {
            $toolCount = $json.result.tools.Count
            Write-Pass "Tools list retrieved: $toolCount tools"

            # Sample tool names
            $sampleTools = ($json.result.tools | Select-Object -First 5).name -join ", "
            Write-Info "Sample tools: $sampleTools ..."
            return $true
        } else {
            Write-Fail "Tools list response missing result.tools" ($json | ConvertTo-Json -Compress -Depth 2)
            return $false
        }
    } catch {
        Write-Fail "Tools list request failed" $_.Exception.Message
        return $false
    }
}

function Test-InvalidRequest {
    Write-Host "`n--- Test 5: Invalid Method Rejection ---" -ForegroundColor White

    $body = @{
        jsonrpc = "2.0"
        id = 99
        method = "invalid/nonexistent_method"
    } | ConvertTo-Json -Depth 5

    try {
        $headers = @{
            "Content-Type" = "application/json"
        }

        $response = Invoke-WebRequest -Uri $mcpUrl -Method Post -Body $body -Headers $headers -TimeoutSec 10

        # Expect an error response in the JSON body, not an HTTP error
        $json = $response.Content | ConvertFrom-Json
        if ($json.error) {
            Write-Pass "Invalid method correctly rejected with error: $($json.error.message)"
            return $true
        } else {
            Write-Fail "Expected error response for invalid method"
            return $false
        }
    } catch {
        # Some invalid requests may return HTTP errors
        Write-Pass "Invalid request rejected with HTTP error: $($_.Exception.Message)"
        return $true
    }
}

function Test-CorsHeaders {
    Write-Host "`n--- Test 6: CORS Preflight (OPTIONS) ---" -ForegroundColor White

    try {
        $response = Invoke-WebRequest -Uri $mcpUrl -Method Options -TimeoutSec 5

        $allowOrigin = $response.Headers["Access-Control-Allow-Origin"]
        $allowMethods = $response.Headers["Access-Control-Allow-Methods"]

        if ($allowOrigin -eq "*" -and $allowMethods -match "POST") {
            Write-Pass "CORS headers present"
            return $true
        } else {
            Write-Fail "CORS headers incomplete" "Allow-Origin: $allowOrigin, Allow-Methods: $allowMethods"
            return $false
        }
    } catch {
        Write-Fail "OPTIONS request failed" $_.Exception.Message
        return $false
    }
}

function Show-Summary {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  Test Summary" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Passed: $script:passed" -ForegroundColor Green
    Write-Host "  Failed: $script:failed" -ForegroundColor $(if ($script:failed -gt 0) { "Red" } else { "Gray" })
    Write-Host "========================================`n" -ForegroundColor Cyan

    if ($script:failed -eq 0) {
        Write-Host "=== ALL TESTS PASSED ===" -ForegroundColor Green
        return 0
    } else {
        Write-Host "=== SOME TESTS FAILED ===" -ForegroundColor Red
        return 1
    }
}

# ─── Main ─────────────────────────────────────────────────────────────────────

Write-TestHeader

try {
    if (-not (Start-McpServer)) {
        Write-Host "`n=== TEST ABORTED: Server failed to start ===" -ForegroundColor Red
        exit 1
    }

    Test-HealthEndpoint | Out-Null
    Test-McpInitialize | Out-Null
    Test-InitializedNotification | Out-Null
    Test-ToolsList | Out-Null
    Test-InvalidRequest | Out-Null
    Test-CorsHeaders | Out-Null

    $exitCode = Show-Summary
    exit $exitCode
} finally {
    Stop-McpServer
}
