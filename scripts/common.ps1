Set-StrictMode -Version Latest

function Import-GatewayEnvironment {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Gateway environment file not found: $Path"
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $value = $line.Trim()
        if (-not $value -or $value.StartsWith('#')) {
            continue
        }
        $separator = $value.IndexOf('=')
        if ($separator -lt 1) {
            continue
        }
        $name = $value.Substring(0, $separator).Trim()
        $setting = $value.Substring($separator + 1).Trim()
        [Environment]::SetEnvironmentVariable($name, $setting, 'Process')
    }
}
function Get-GatewayChromePath {
    $candidates = @(
        $env:CHROME_PATH,
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { $_ }

    return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
