param(
    [string]$CodexHome,
    [string]$BaseUrl = "http://localhost:3001/openai-codex-oauth/v1",
    [string]$ProviderName = "codexzh",
    [string]$DefaultModel = "gpt-5.5-free",
    [string]$ReasoningEffort = "xhigh",
    [string]$PlanModeReasoningEffort = "xhigh",
    [switch]$DryRun,
    [switch]$NoBackup,
    [switch]$NoPause
)

$ErrorActionPreference = "Stop"

function Get-DefaultCodexHome {
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return (Join-Path $env:USERPROFILE ".codex")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:HOME)) {
        return (Join-Path $env:HOME ".codex")
    }
    throw "Unable to locate user home directory. Pass -CodexHome explicitly."
}

function Convert-ToTomlString {
    param([string]$Value)

    $escaped = $Value.Replace("\", "\\").Replace('"', '\"')
    return '"' + $escaped + '"'
}

function Backup-File {
    param(
        [string]$PathValue,
        [string]$Stamp
    )

    if ($NoBackup -or $DryRun -or -not (Test-Path -LiteralPath $PathValue)) {
        return $null
    }

    $backupPath = "$PathValue.bak-gpt55-$Stamp"
    Copy-Item -LiteralPath $PathValue -Destination $backupPath -Force
    return $backupPath
}

function Set-TopLevelTomlKeys {
    param(
        [string]$Content,
        [hashtable]$Keys
    )

    $lines = @()
    if (-not [string]::IsNullOrEmpty($Content)) {
        $lines = @($Content -split "`r?`n", -1)
    }

    $firstSectionIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*\[') {
            $firstSectionIndex = $i
            break
        }
    }

    if ($firstSectionIndex -lt 0) {
        $topLines = $lines
        $restLines = @()
    } else {
        $topLines = if ($firstSectionIndex -eq 0) { @() } else { @($lines[0..($firstSectionIndex - 1)]) }
        $restLines = @($lines[$firstSectionIndex..($lines.Count - 1)])
    }

    $keyPattern = '^(\s*)(' + (($Keys.Keys | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')\s*='
    $topLines = @($topLines | Where-Object { $_ -notmatch $keyPattern })

    $newTopLines = @()
    foreach ($name in @("model", "model_reasoning_effort", "model_provider", "plan_mode_reasoning_effort", "model_catalog_json")) {
        if ($Keys.ContainsKey($name)) {
            $newTopLines += "$name = $($Keys[$name])"
        }
    }

    $merged = @($newTopLines + "" + $topLines)
    while ($merged.Count -gt 0 -and [string]::IsNullOrWhiteSpace($merged[-1])) {
        $merged = if ($merged.Count -eq 1) { @() } else { @($merged[0..($merged.Count - 2)]) }
    }

    if ($restLines.Count -gt 0) {
        return (@($merged + "" + $restLines) -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine
    }

    return ($merged -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine
}

function Remove-TomlSection {
    param(
        [string]$Content,
        [string]$SectionName
    )

    if ([string]::IsNullOrWhiteSpace($Content)) {
        return ""
    }

    $lines = @($Content -split "`r?`n", -1)
    $result = @()
    $insideTarget = $false
    $sectionPattern = '^\s*\[' + [regex]::Escape($SectionName) + '\]\s*$'

    foreach ($line in $lines) {
        if ($line -match '^\s*\[') {
            $insideTarget = $line -match $sectionPattern
            if ($insideTarget) {
                continue
            }
        }

        if (-not $insideTarget) {
            $result += $line
        }
    }

    return ($result -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine
}

function Add-ProviderSection {
    param(
        [string]$Content,
        [string]$Provider,
        [string]$Url
    )

    $section = @(
        "[model_providers.$Provider]",
        "name = $(Convert-ToTomlString $Provider)",
        "base_url = $(Convert-ToTomlString $Url)",
        'wire_api = "responses"',
        "requires_openai_auth = true",
        'web_search = "live"'
    ) -join [Environment]::NewLine

    return $Content.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $section + [Environment]::NewLine
}

function Write-Utf8NoBom {
    param(
        [string]$PathValue,
        [string]$Content
    )

    $directory = [System.IO.Path]::GetDirectoryName($PathValue)
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($PathValue, $Content, $encoding)
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceCatalogPath = Join-Path $scriptDir "model-catalog.gpt-5.5.json"
if (-not (Test-Path -LiteralPath $sourceCatalogPath)) {
    throw "Bundled model catalog is missing: $sourceCatalogPath"
}

if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = Get-DefaultCodexHome
}

$CodexHome = [System.IO.Path]::GetFullPath($CodexHome)
$configPath = Join-Path $CodexHome "config.toml"
$catalogPath = Join-Path $CodexHome "model-catalog.gpt-5.5.json"
$stamp = Get-Date -Format "yyyyMMddHHmmss"

$existingConfig = ""
if (Test-Path -LiteralPath $configPath) {
    $existingConfig = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)
}

$keys = @{
    model = Convert-ToTomlString $DefaultModel
    model_reasoning_effort = Convert-ToTomlString $ReasoningEffort
    model_provider = Convert-ToTomlString $ProviderName
    plan_mode_reasoning_effort = Convert-ToTomlString $PlanModeReasoningEffort
    model_catalog_json = Convert-ToTomlString $catalogPath
}

$newConfig = Set-TopLevelTomlKeys $existingConfig $keys
$newConfig = Remove-TomlSection $newConfig "model_providers.$ProviderName"
$newConfig = Add-ProviderSection $newConfig $ProviderName $BaseUrl

$backups = [ordered]@{
    config = Backup-File $configPath $stamp
    catalog = Backup-File $catalogPath $stamp
}

if (-not $DryRun) {
    [System.IO.Directory]::CreateDirectory($CodexHome) | Out-Null
    Copy-Item -LiteralPath $sourceCatalogPath -Destination $catalogPath -Force
    Write-Utf8NoBom $configPath $newConfig
}

$summary = [ordered]@{
    ok = $true
    dryRun = [bool]$DryRun
    codexHome = $CodexHome
    files = [ordered]@{
        config = $configPath
        modelCatalog = $catalogPath
    }
    backups = $backups
    provider = [ordered]@{
        name = $ProviderName
        baseUrl = $BaseUrl
        wireApi = "responses"
    }
    defaultModel = $DefaultModel
    installedModels = @(
        "gpt-5.5",
        "gpt-5.5-free",
        "gpt-5.5-plus",
        "gpt-5.5-pro",
        "gpt-5.5 free",
        "gpt-5.5 plus",
        "gpt-5.5 pro"
    )
}

ConvertTo-Json -InputObject $summary -Depth 20

if (-not $NoPause -and -not $env:WT_SESSION -and $Host.Name -match "ConsoleHost") {
    Write-Host ""
    Write-Host "Press Enter to exit..."
    [void][Console]::ReadLine()
}
