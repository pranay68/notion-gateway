# Clean Notion Provider

Local OpenAI-style chat-completions provider backed by a dedicated Notion desktop session.

## Runtime

- Endpoint: `POST http://127.0.0.1:3040/v1/chat/completions`
- Health: `GET http://127.0.0.1:3040/health`
- Readiness/CDP: `GET http://127.0.0.1:3040/ready`
- Manual idle cleanup: `POST http://127.0.0.1:3040/cleanup`
- Notion CDP: `127.0.0.1:9333`
- Concurrency: 1 active request, 50 queued by default
- Hard request/job timeout: disabled by default
- HTTP request body limit: disabled by default

Start with:

```powershell
npm install
npm start
```

The bridge launches the installed Notion desktop app with `--remote-debugging-port=9333` when needed. The Notion profile must already be signed in to the `Lex` workspace.

## Provider Contract

Send provider-style `messages` with clean roles. For structured output, include `response_format` or `schema`.

```json
{
  "model": "notion-gateway",
  "messages": [
    { "role": "system", "content": "Return raw JSON only." },
    { "role": "user", "content": "Return exactly {\"status\":\"ok\"}" }
  ],
  "response_format": { "type": "json_object" }
}
```

Read the result from `choices[0].message.content`.

## Tab Lifecycle

Every request receives an isolated Notion chat target. Active and queued work blocks cleanup. Once the bridge is idle, cleanup uses Notion's real Electron tab-bar `Close Tab` controls and trims oldest tabs until seven remain. It does not close CDP renderer targets, because Notion restores those fake closures. An idle sweep runs every 30 seconds. Override the retained count with `CLEAN_BRIDGE_MAX_RETAINED_TABS`.

An independent overlay watchdog scans every attached Notion page every 1.5 seconds, including while API workers are active. It uses trusted CDP mouse input to click only an exact visible `Got it` button. This prevents the trial/business-plan modal from blocking prompt submission. Override its interval with `CLEAN_BRIDGE_OVERLAY_WATCH_INTERVAL_MS`.

Long payloads are lossless by local bridge contract: request-body limiting is disabled, prompts are inserted in chunks, semantic DOM reads are full-length, internal response whitespace is preserved, and the ReArch Notion adapter performs an unbounded response read without sending `max_tokens`. `CLEAN_BRIDGE_ACTIVE_QUIET_MS` defaults to 120 seconds to avoid treating a long generation pause as completion.

Answer generation remains unbounded, but a submitted owned chat that shows no generation evidence at all is a mechanical dead start rather than a long answer. `CLEAN_BRIDGE_ANSWER_NO_OUTPUT_TIMEOUT_MS` defaults to 180000; after that interval the bridge saves a transport artifact, releases the worker, and advances the queue. Candidate text, an active stop control, copy-ready state, a finished marker, or complete JSON evidence keeps healthy generation alive without a total timeout.

Important: the old bridge observed `100000` rendered characters in the composer during a failed automated insertion path, but that is not proven to be Notion's true manual paste/model limit. Treat it as an automation/readback-path symptom. The bridge must not hard-block on that number; if transport inserts text and the composer is submit-ready, a rendered-length mismatch is recorded as evidence and the request proceeds.

Artifacts default to `../work/notion-bridge-clean` relative to this repository. Set `CLEAN_BRIDGE_ARTIFACT_DIR` to use another location. Artifacts can contain prompts, UI snapshots, transitions, outputs, and failure evidence; do not commit them.

## Prompt Transport

Prompt insertion is now a layered transport ladder, not a single Windows clipboard path.

Primary order:

1. `cdp_insert_text`: focus the Notion AI composer through CDP, clear it, insert prompt chunks with `Input.insertText`, then submit when the composer is ready. Exact rendered text is accepted when available, but long-prompt rendered readback mismatch is not treated as a size limit.
2. `dom_editor_insert`: if CDP text insertion changes formatting or does not produce a submit-ready composer, set the editable composer content through the DOM/editor path and dispatch input/change events, then use the same submit-ready gate.
3. `clipboard_paste`: opt-in emergency fallback only, using `Set-Clipboard` plus `Ctrl+V` with retry/backoff. Clipboard is disabled by default and no longer required for normal operation.

Important proof result from the isolated `3041` proof branch on 2026-06-30:

- `Input.insertText` successfully reached Notion, but Notion collapsed some newline boundaries, so strict verification failed.
- `dom_editor_insert` preserved exact prompt text and completed live calls without using clipboard.
- Small JSON proof returned `{"insert_text_probe":"ok"}`.
- Medium `15,559` character proof inserted and submitted without clipboard fallback.
- Therefore production should keep the full ladder. Do not simplify to `Input.insertText` only.

Useful runtime knobs:

```powershell
$env:CLEAN_BRIDGE_INSERT_CHUNK_CHARS='8000'
$env:CLEAN_BRIDGE_INSERT_VERIFY_TIMEOUT_MS='120000'
$env:CLEAN_BRIDGE_CLIPBOARD_FALLBACK='0'
$env:CLEAN_BRIDGE_CLIPBOARD_ATTEMPTS='3'
```

Set `CLEAN_BRIDGE_CLIPBOARD_FALLBACK=1` only for emergency compatibility testing. `GET /ready` is read-only and must not focus or clear the composer during live runs. The old `GET /ready?composer=1` path is intentionally rejected because readiness probes must not mutate an active Notion request surface.

## Checks

```powershell
npm test
npm run health
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3040/ready -TimeoutSec 35 | Select-Object -ExpandProperty Content
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3040/ready' -TimeoutSec 120 | Select-Object -ExpandProperty Content
```

Do not run a full ReArch mission merely to test the bridge. Start with one schema-shaped provider request.
