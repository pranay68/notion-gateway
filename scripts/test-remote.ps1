[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProviderUrl,
    [Parameter(Mandatory)][string]$Token,
    [switch]$Generation
)

$ErrorActionPreference = 'Stop'
$base = $ProviderUrl.TrimEnd('/')
$headers = @{ Authorization = "Bearer $Token" }
$health = Invoke-RestMethod -Uri "$base/health" -Headers $headers -TimeoutSec 15
$health | ConvertTo-Json -Depth 8

if ($Generation) {
    $body = @{
        model = 'notion-gateway'
        messages = @(
            @{ role = 'system'; content = 'Return raw JSON only.' }
            @{ role = 'user'; content = 'Return exactly {"remote_gateway":"ok"}' }
        )
        response_format = @{ type = 'json_object' }
    } | ConvertTo-Json -Depth 8
    $response = Invoke-RestMethod -Method Post -Uri "$base/v1/chat/completions" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 1800
    $response.choices[0].message.content
}
