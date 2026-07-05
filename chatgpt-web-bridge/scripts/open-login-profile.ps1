param(
    [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (Test-Path -LiteralPath $EnvFile) {
    Get-Content -LiteralPath $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
        $key, $value = $line.Split("=", 2)
        [Environment]::SetEnvironmentVariable($key.Trim(), $value.Trim(), "Process")
    }
}

$profile = $env:CHATGPT_USER_DATA_DIR
if (-not $profile) {
    $profile = Join-Path $root "profiles\chatgpt-provider"
}
if (-not [System.IO.Path]::IsPathRooted($profile)) {
    $profile = Join-Path $root $profile
}
New-Item -ItemType Directory -Force -Path $profile | Out-Null

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

if (-not $chrome) {
    throw "Google Chrome was not found. Install Chrome or set the path in this script."
}

Write-Host "Opening normal Chrome login profile:"
Write-Host $profile
Write-Host ""
Write-Host "Sign into ChatGPT manually, then close this Chrome window before starting the bridge."

Start-Process -FilePath $chrome -ArgumentList @(
    "--user-data-dir=$profile",
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "https://chatgpt.com/"
)
