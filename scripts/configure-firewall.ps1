[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidatePattern('^\d{1,3}(\.\d{1,3}){3}$')][string]$MainLaptopIp,
    [ValidateRange(1, 65535)][int]$Port = 3040
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell window.'
}

$ruleName = "Notion Gateway from $MainLaptopIp"
if ($PSCmdlet.ShouldProcess($ruleName, "Allow TCP $Port only from $MainLaptopIp")) {
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $Port `
        -RemoteAddress $MainLaptopIp `
        -Profile Private | Out-Null
    Write-Host "Firewall allows TCP $Port from $MainLaptopIp only." -ForegroundColor Green
}

