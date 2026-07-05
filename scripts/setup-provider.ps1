[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repo '.env'

if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'winget is required to install Node.js and Chrome.'
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
}

. (Join-Path $PSScriptRoot 'common.ps1')
if (-not (Get-GatewayChromePath)) {
    winget install --id Google.Chrome --exact --accept-package-agreements --accept-source-agreements
}

if (-not (Test-Path -LiteralPath $envFile)) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    (Get-Content -LiteralPath (Join-Path $repo '.env.example')) |
        ForEach-Object { $_ -replace '^CLEAN_BRIDGE_API_TOKEN=.*$', "CLEAN_BRIDGE_API_TOKEN=$token" } |
        Set-Content -LiteralPath $envFile -Encoding ascii
}

New-Item -ItemType Directory -Path (Join-Path $repo 'data\chrome-profile') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $repo 'artifacts') -Force | Out-Null

Push-Location $repo
try {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
        npm.cmd install
    } else {
        Write-Warning 'Node.js was installed. Open a new PowerShell window, return to this repository, and rerun this script.'
    }
} finally {
    Pop-Location
}

Write-Host 'Provider setup complete.' -ForegroundColor Green
Write-Host 'Next: .\scripts\start-provider.ps1'
