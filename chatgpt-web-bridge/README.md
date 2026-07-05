# ChatGPT Web Bridge

Experimental sidecar provider. This does not modify the Notion gateway.

It runs a dedicated Chrome profile signed into ChatGPT and exposes an OpenAI-style local endpoint:

```text
POST http://127.0.0.1:3041/v1/chat/completions
```

Response content is returned at:

```text
choices[0].message.content
```

## Start

```powershell
cd chatgpt-web-bridge
copy .env.example .env
.\scripts\start-provider.ps1
```

## First Login

For first login, do not use the automated bridge window. Open the exact same dedicated profile in normal Chrome:

```powershell
.\scripts\open-login-profile.ps1
```

Sign into ChatGPT manually, then close that Chrome window. After that, start the provider:

```powershell
.\scripts\start-provider.ps1
```

The runtime launches normal Chrome with a minimal CDP attach port and the dedicated profile. It does not use your normal Chrome profile.

After startup:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3041/ready
```

## Runtime Behavior

- Default mode is non-interruptive: `CHATGPT_BRING_TO_FRONT=false`.
- The bridge attaches to normal Chrome with `--remote-debugging-port=9444`.
- Prompt insertion uses a background-safe locator fill path first.
- Keyboard insertion exists only as fallback when locator fill cannot verify request anchors.
- Keep `CHATGPT_MAX_CONCURRENT=1`; burst requests queue safely instead of competing for the same ChatGPT UI.
- Do not use the provider Chrome profile for normal browsing.

## Test Generation

```powershell
$body = @{
  messages = @(
    @{ role = "system"; content = "Answer exactly and do not explain." },
    @{ role = "user"; content = "Reply only: {`"ok`":true}" }
  )
} | ConvertTo-Json -Depth 8

Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3041/v1/chat/completions -Method POST -ContentType "application/json" -Body $body
```

## Boundaries

- This is an unofficial UI transport experiment.
- Keep concurrency at `1` until live selector behavior is proven.
- Do not point ReArch at this until `/ready` and one generation probe pass.
- Current Notion gateway remains the stable lane.
