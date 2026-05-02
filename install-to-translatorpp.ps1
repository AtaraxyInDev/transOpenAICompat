param(
    [string]$TranslatorRoot = "C:\Program Files\Translator++"
)

$ErrorActionPreference = "Stop"

function Ensure-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) {
        return
    }

    $argList = @(
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-TranslatorRoot", "`"$TranslatorRoot`""
    )
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList | Out-Null
    exit
}

Ensure-Admin

$sourceDir = Split-Path -Parent $PSCommandPath
$addonName = Split-Path -Leaf $sourceDir
$targetAddonsDir = Join-Path $TranslatorRoot "www\addons"
$targetDir = Join-Path $targetAddonsDir $addonName
$backupRoot = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "TranslatorPP-Addons\backups"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

if (!(Test-Path $TranslatorRoot)) {
    throw "Translator++ root not found: $TranslatorRoot"
}

if (!(Test-Path $targetAddonsDir)) {
    throw "Target addons folder not found: $targetAddonsDir"
}

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

if (Test-Path $targetDir) {
    $backupDir = Join-Path $backupRoot "$addonName-$timestamp"
    Copy-Item -LiteralPath $targetDir -Destination $backupDir -Recurse -Force
    Write-Host "Backup created at $backupDir"
}

if (Test-Path $targetDir) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
}

Copy-Item -LiteralPath $sourceDir -Destination $targetDir -Recurse -Force
Write-Host "Addon installed to $targetDir"
Write-Host "Restart Translator++ if it is open."
