[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
Import-GatewayEnvironment -Path (Join-Path $repo '.env')

$chrome = Get-GatewayChromePath
if (-not $chrome) {
    throw 'Google Chrome is not installed. Run setup-provider.ps1 first.'
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not available. Run setup-provider.ps1, then open a new PowerShell window.'
}
if (-not $env:CLEAN_BRIDGE_API_TOKEN) {
    throw 'CLEAN_BRIDGE_API_TOKEN is required.'
}

$env:NOTION_RUNTIME = 'chrome'
$env:CHROME_PATH = $chrome
$env:CHROME_USER_DATA_DIR = Join-Path $repo 'data\chrome-profile'
$env:CLEAN_BRIDGE_ARTIFACT_DIR = Join-Path $repo 'artifacts'
$env:NOTION_DEBUG_HOST = '127.0.0.1'

Push-Location $repo
try {
    node.exe server.js
} finally {
    Pop-Location
}

