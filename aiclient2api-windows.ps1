$ErrorActionPreference = "Stop"

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # Older hosts may not allow changing console encoding.
}

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateFile = if ($env:AICLIENT2API_STATE_FILE) { $env:AICLIENT2API_STATE_FILE } else { Join-Path $ProjectDir ".aiclient2api.windows.pid.json" }
$LogDir = if ($env:LOG_DIR) { $env:LOG_DIR } else { Join-Path $ProjectDir "logs" }
$StdOutLog = if ($env:LOG_FILE) { $env:LOG_FILE } else { Join-Path $LogDir "aiclient2api.windows.out.log" }
$StdErrLog = if ($env:ERR_LOG_FILE) { $env:ERR_LOG_FILE } else { Join-Path $LogDir "aiclient2api.windows.err.log" }
$StopTimeout = if ($env:STOP_TIMEOUT) { [int]$env:STOP_TIMEOUT } else { 20 }
$DefaultPort = 3001
$DefaultPackageRegistry = "https://registry.npmmirror.com"

function Write-Info {
    param([string]$Message)
    Write-Host "[AIClient2API] $Message"
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[AIClient2API][WARN] $Message" -ForegroundColor Yellow
}

function Fail {
    param([string]$Message)
    Write-Host "[AIClient2API][ERROR] $Message" -ForegroundColor Red
    exit 1
}

function Show-Usage {
    $scriptName = Split-Path -Leaf $MyInvocation.ScriptName
    Write-Host @"
Usage:
  .\$scriptName deploy [--pull] [--npm|--pnpm] [--registry <url>]
  .\$scriptName start [app args...]
  .\$scriptName stop
  .\$scriptName restart [app args...]
  .\$scriptName status

Shortcut scripts:
  deploy-windows.cmd [--pull] [--npm|--pnpm] [--registry <url>]
  start-windows.cmd [app args...]
  stop-windows.cmd
  restart-windows.cmd [app args...]
  status-windows.cmd

Environment variables:
  AICLIENT2API_STATE_FILE  PID state file. Default: $StateFile
  AICLIENT2API_PACKAGE_MANAGER  Dependency installer: auto, npm, or pnpm. Default: auto
  AICLIENT2API_NPM_REGISTRY  Dependency registry. Default: $DefaultPackageRegistry
  LOG_DIR                  Log directory. Default: $LogDir
  LOG_FILE                 stdout log file. Default: $StdOutLog
  ERR_LOG_FILE             stderr log file. Default: $StdErrLog
  STOP_TIMEOUT             Stop timeout in seconds. Default: $StopTimeout
"@
}

function Enter-Project {
    Set-Location -LiteralPath $ProjectDir
}

function Require-ProjectFiles {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "package.json"))) {
        Fail "package.json was not found. Run this script from the project root."
    }

    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "src\core\master.js"))) {
        Fail "src\core\master.js was not found."
    }
}

function Require-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Fail "Node.js was not found. Install the Node.js LTS version first: https://nodejs.org/"
    }

    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) {
        Fail "npm was not found. Reinstall Node.js or repair your PATH."
    }

    $version = (& node --version) -join ""
    Write-Info "Node.js detected: $version"
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE"
    }
}

function Quote-WindowsArgument {
    param([AllowNull()][string]$Argument)

    if ($null -eq $Argument -or $Argument.Length -eq 0) {
        return '""'
    }

    if ($Argument -notmatch '[\s"]') {
        return $Argument
    }

    $quoted = '"'
    $backslashes = 0

    foreach ($char in $Argument.ToCharArray()) {
        if ($char -eq '\') {
            $backslashes++
            continue
        }

        if ($char -eq '"') {
            $quoted += ('\' * (($backslashes * 2) + 1))
            $quoted += '"'
            $backslashes = 0
            continue
        }

        if ($backslashes -gt 0) {
            $quoted += ('\' * $backslashes)
            $backslashes = 0
        }

        $quoted += $char
    }

    if ($backslashes -gt 0) {
        $quoted += ('\' * ($backslashes * 2))
    }

    $quoted += '"'
    return $quoted
}

function Copy-ExampleIfMissing {
    param([string]$RelativePath)

    $target = Join-Path $ProjectDir $RelativePath
    $example = "$target.example"

    if ((Test-Path -LiteralPath $target) -or -not (Test-Path -LiteralPath $example)) {
        return $false
    }

    Copy-Item -LiteralPath $example -Destination $target
    Write-Info "Created $RelativePath from example."
    return $true
}

function Initialize-ConfigFiles {
    $configDir = Join-Path $ProjectDir "configs"
    if (-not (Test-Path -LiteralPath $configDir)) {
        New-Item -ItemType Directory -Path $configDir | Out-Null
    }

    $createdConfig = Copy-ExampleIfMissing "configs\config.json"
    Copy-ExampleIfMissing "configs\provider_pools.json" | Out-Null
    Copy-ExampleIfMissing "configs\plugins.json" | Out-Null
    Copy-ExampleIfMissing "configs\custom_models.json" | Out-Null
    Copy-ExampleIfMissing "configs\market.json" | Out-Null

    $systemPrompt = Join-Path $configDir "input_system_prompt.txt"
    if (-not (Test-Path -LiteralPath $systemPrompt)) {
        New-Item -ItemType File -Path $systemPrompt | Out-Null
        Write-Info "Created configs\input_system_prompt.txt."
    }

    if ($createdConfig) {
        $configPath = Join-Path $ProjectDir "configs\config.json"
        try {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            $config.SERVER_PORT = $DefaultPort
            $config | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $configPath -Encoding UTF8
            Write-Info "Set default SERVER_PORT to $DefaultPort in configs\config.json."
        } catch {
            Write-Warn "Could not update SERVER_PORT in configs\config.json: $($_.Exception.Message)"
        }
    }
}

function Get-ServerPort {
    $configPath = Join-Path $ProjectDir "configs\config.json"
    if (-not (Test-Path -LiteralPath $configPath)) {
        return $DefaultPort
    }

    try {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($config.SERVER_PORT) {
            return [int]$config.SERVER_PORT
        }
    } catch {
        Write-Warn "Could not read SERVER_PORT from configs\config.json: $($_.Exception.Message)"
    }

    return $DefaultPort
}

function Resolve-PackageManager {
    param([string[]]$Arguments)

    $packageManager = if ($env:AICLIENT2API_PACKAGE_MANAGER) { $env:AICLIENT2API_PACKAGE_MANAGER.ToLowerInvariant() } else { "auto" }

    foreach ($argument in $Arguments) {
        $normalized = $argument.ToLowerInvariant()

        if ($normalized -eq "--npm") {
            $packageManager = "npm"
        } elseif ($normalized -eq "--pnpm") {
            $packageManager = "pnpm"
        } elseif ($normalized.StartsWith("--pm=")) {
            $packageManager = $normalized.Substring(5)
        } elseif ($normalized.StartsWith("--package-manager=")) {
            $packageManager = $normalized.Substring(18)
        }
    }

    if (@("auto", "npm", "pnpm") -notcontains $packageManager) {
        Fail "Invalid package manager: $packageManager. Use auto, npm, or pnpm."
    }

    return $packageManager
}

function Resolve-PackageRegistry {
    param([string[]]$Arguments)

    if ($env:AICLIENT2API_NPM_REGISTRY) {
        $registry = $env:AICLIENT2API_NPM_REGISTRY
    } else {
        $registry = $DefaultPackageRegistry
    }

    for ($index = 0; $index -lt $Arguments.Count; $index++) {
        $argument = $Arguments[$index]
        $normalized = $argument.ToLowerInvariant()

        if ($normalized -eq "--registry") {
            if ($index + 1 -ge $Arguments.Count) {
                Fail "--registry requires a URL."
            }

            $registry = $Arguments[$index + 1]
            $index++
        } elseif ($normalized.StartsWith("--registry=")) {
            $registry = $argument.Substring(11)
        } elseif ($normalized.StartsWith("--npm-registry=")) {
            $registry = $argument.Substring(15)
        }
    }

    if ([string]::IsNullOrWhiteSpace($registry)) {
        Fail "Package registry cannot be empty."
    }

    if ($registry -notmatch '^https?://') {
        Fail "Package registry must start with http:// or https://"
    }

    return $registry.TrimEnd("/")
}

function Get-PackageRegistryArguments {
    param(
        [string]$Registry,
        [switch]$ForNpm
    )

    $arguments = @("--registry=$Registry")

    if ($ForNpm) {
        $arguments += "--replace-registry-host=always"
    }

    return $arguments
}

function Install-Dependencies {
    param(
        [string]$PackageManager = "auto",
        [string]$Registry = $DefaultPackageRegistry
    )

    $packageManager = $PackageManager.ToLowerInvariant()
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    $npm = Get-Command npm -ErrorAction Stop
    $hasPnpmLock = Test-Path -LiteralPath (Join-Path $ProjectDir "pnpm-lock.yaml")
    $hasPackageLock = Test-Path -LiteralPath (Join-Path $ProjectDir "package-lock.json")

    $env:NPM_CONFIG_REGISTRY = $Registry
    $env:npm_config_registry = $Registry
    Write-Info "Dependency registry: $Registry"

    if ($packageManager -eq "pnpm" -and -not $pnpm) {
        Fail "pnpm was requested but was not found. Install pnpm, or use deploy-windows.cmd --npm."
    }

    if ($packageManager -ne "npm" -and $pnpm -and ($packageManager -eq "pnpm" -or $hasPnpmLock)) {
        Write-Info "Installing dependencies with pnpm install..."
        try {
            Invoke-Checked $pnpm.Source (@("install") + (Get-PackageRegistryArguments $Registry))
            return
        } catch {
            if ($packageManager -eq "pnpm") {
                Fail "pnpm install failed: $($_.Exception.Message)"
            }

            Write-Warn "pnpm install failed: $($_.Exception.Message)"
            Write-Warn "Trying npm instead."
        }
    }

    if ($hasPackageLock) {
        Write-Info "Installing dependencies with npm ci..."
        try {
            Invoke-Checked $npm.Source (@("ci") + (Get-PackageRegistryArguments $Registry -ForNpm))
            return
        } catch {
            Write-Warn "npm ci failed, falling back to npm install."
        }
    }

    Write-Info "Installing dependencies with npm install..."
    Invoke-Checked $npm.Source (@("install") + (Get-PackageRegistryArguments $Registry -ForNpm))
}

function Read-State {
    if (-not (Test-Path -LiteralPath $StateFile)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    } catch {
        Write-Warn "State file is unreadable. Removing stale state."
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        return $null
    }
}

function Write-State {
    param([System.Diagnostics.Process]$Process)

    $Process.Refresh()
    $state = [ordered]@{
        pid = $Process.Id
        startTimeUtcTicks = $Process.StartTime.ToUniversalTime().Ticks
        projectDir = $ProjectDir
        stdoutLog = $StdOutLog
        stderrLog = $StdErrLog
        port = Get-ServerPort
        createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }

    $state | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Get-StateProcess {
    param($State)

    if (-not $State -or -not $State.pid) {
        return $null
    }

    try {
        $process = Get-Process -Id ([int]$State.pid) -ErrorAction Stop
        if ($State.startTimeUtcTicks) {
            $ticks = $process.StartTime.ToUniversalTime().Ticks
            if ($ticks -ne [int64]$State.startTimeUtcTicks) {
                return $null
            }
        }
        return $process
    } catch {
        return $null
    }
}

function Get-ChildProcessIds {
    param([int]$ParentProcessId)

    $result = New-Object System.Collections.Generic.List[int]
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentProcessId" -ErrorAction SilentlyContinue

    foreach ($child in $children) {
        $grandChildren = Get-ChildProcessIds ([int]$child.ProcessId)
        foreach ($grandChild in $grandChildren) {
            $result.Add([int]$grandChild)
        }
        $result.Add([int]$child.ProcessId)
    }

    return $result.ToArray()
}

function Stop-ProcessTree {
    param([int]$RootProcessId)

    $processIds = @(Get-ChildProcessIds $RootProcessId) + @($RootProcessId)
    foreach ($processId in $processIds) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

function Wait-ProcessExit {
    param(
        [int]$ProcessId,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if (-not $process) {
            return $true
        }
        Start-Sleep -Seconds 1
    }

    return $false
}

function Deploy-App {
    param([string[]]$Arguments)

    Enter-Project
    Require-ProjectFiles
    Require-Node

    if ($Arguments -contains "--pull") {
        $git = Get-Command git -ErrorAction SilentlyContinue
        if ($git) {
            Write-Info "Pulling latest code..."
            Invoke-Checked $git.Source @("pull")
        } else {
            Write-Warn "git was not found. Skipping pull."
        }
    }

    Initialize-ConfigFiles
    $packageManager = Resolve-PackageManager $Arguments
    $registry = Resolve-PackageRegistry $Arguments
    Install-Dependencies $packageManager $registry

    $port = Get-ServerPort
    Write-Info "Deploy complete."
    Write-Info "Use start-windows.cmd to start the service."
    Write-Info "Expected UI: http://localhost:$port"
}

function Start-App {
    param([string[]]$AppArguments)

    Enter-Project
    Require-ProjectFiles
    Require-Node

    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "node_modules"))) {
        Fail "node_modules was not found. Run deploy-windows.cmd first."
    }

    $state = Read-State
    $existing = Get-StateProcess $state
    if ($existing) {
        Write-Info "Service is already running. PID: $($existing.Id)"
        Write-Info "stdout: $StdOutLog"
        Write-Info "stderr: $StdErrLog"
        return
    }

    if ($state) {
        Write-Warn "Removing stale state file."
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path -LiteralPath $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir | Out-Null
    }

    $node = Get-Command node -ErrorAction Stop
    $arguments = @("src\core\master.js") + $AppArguments
    $argumentLine = ($arguments | ForEach-Object { Quote-WindowsArgument $_ }) -join " "

    Write-Info "Starting service..."
    Write-Info "stdout: $StdOutLog"
    Write-Info "stderr: $StdErrLog"

    $process = Start-Process `
        -FilePath $node.Source `
        -ArgumentList $argumentLine `
        -WorkingDirectory $ProjectDir `
        -RedirectStandardOutput $StdOutLog `
        -RedirectStandardError $StdErrLog `
        -WindowStyle Hidden `
        -PassThru

    Write-State $process

    Start-Sleep -Seconds 2
    $running = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if (-not $running) {
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        Fail "Service failed to start. Check logs: $StdOutLog and $StdErrLog"
    }

    $port = Get-ServerPort
    Write-Info "Service started. PID: $($process.Id)"
    Write-Info "UI: http://localhost:$port"
}

function Stop-App {
    $state = Read-State
    $process = Get-StateProcess $state

    if (-not $process) {
        Write-Info "Service is not running."
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        return
    }

    Write-Info "Stopping service. PID: $($process.Id)"
    Stop-ProcessTree ([int]$process.Id)

    if (-not (Wait-ProcessExit ([int]$process.Id) $StopTimeout)) {
        Write-Warn "Process did not exit within $StopTimeout seconds."
    }

    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    Write-Info "Service stopped."
}

function Status-App {
    $state = Read-State
    $process = Get-StateProcess $state

    if (-not $process) {
        Write-Info "Service is not running."
        if ($state) {
            Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        }
        exit 1
    }

    $port = if ($state.port) { [int]$state.port } else { Get-ServerPort }
    Write-Info "Service is running. PID: $($process.Id)"
    Write-Info "UI: http://localhost:$port"
    Write-Info "stdout: $($state.stdoutLog)"
    Write-Info "stderr: $($state.stderrLog)"
}

$rawArgs = @($args)
$command = if ($rawArgs.Count -gt 0) { $rawArgs[0].ToLowerInvariant() } else { "help" }
$remaining = if ($rawArgs.Count -gt 1) { $rawArgs[1..($rawArgs.Count - 1)] } else { @() }

switch ($command) {
    "deploy" { Deploy-App $remaining }
    "install" { Deploy-App $remaining }
    "start" { Start-App $remaining }
    "stop" { Stop-App }
    "restart" {
        Stop-App
        Start-App $remaining
    }
    "status" { Status-App }
    "help" { Show-Usage }
    "-h" { Show-Usage }
    "--help" { Show-Usage }
    default {
        Show-Usage
        Fail "Unknown command: $command"
    }
}
