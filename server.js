"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const HOST = process.env.CLEAN_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.CLEAN_BRIDGE_PORT || 3040);
const DEBUG_PORT = Number(process.env.NOTION_DEBUG_PORT || 9333);
const NOTION_URL = process.env.NOTION_AI_URL || "https://www.notion.so/ai";
const NOTION_EXE =
  process.env.NOTION_PATH ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "Notion", "Notion.exe");
const REQUEST_TIMEOUT_MS = Math.max(0, Number(process.env.CLEAN_BRIDGE_TIMEOUT_MS || 0));
const POLL_MS = Number(process.env.CLEAN_BRIDGE_POLL_MS || 1000);
const QUIET_MS = Number(process.env.CLEAN_BRIDGE_QUIET_MS || 10000);
const ACTIVE_QUIET_MS = Number(process.env.CLEAN_BRIDGE_ACTIVE_QUIET_MS || 30000);
const ARTIFACT_DIR = process.env.CLEAN_BRIDGE_ARTIFACT_DIR || path.join(__dirname, "..", "work", "notion-bridge-clean");
const MAX_BODY_BYTES = Math.max(0, Number(process.env.MAX_BODY_BYTES || 0));
const MAX_CONCURRENT_REQUESTS = Math.max(1, Number(process.env.CLEAN_BRIDGE_MAX_CONCURRENT || 1));
const MAX_QUEUE_DEPTH = Math.max(0, Number(process.env.CLEAN_BRIDGE_MAX_QUEUE || 50));
const JOB_TIMEOUT_MS = Math.max(0, Number(process.env.CLEAN_BRIDGE_JOB_TIMEOUT_MS || 0));
const CLEANUP_INTERVAL_MS = Math.max(5000, Number(process.env.CLEAN_BRIDGE_CLEANUP_INTERVAL_MS || 30000));
const MAX_RETAINED_TABS = Math.max(1, Number(process.env.CLEAN_BRIDGE_MAX_RETAINED_TABS || 7));
const OVERLAY_WATCH_INTERVAL_MS = Math.max(500, Number(process.env.CLEAN_BRIDGE_OVERLAY_WATCH_INTERVAL_MS || 1500));
const ALLOW_STALE_RECOVERY = /^(1|true|yes)$/i.test(String(process.env.CLEAN_BRIDGE_ALLOW_STALE_RECOVERY || ""));
const USE_NATIVE_CTRL_O = /^(1|true|yes)$/i.test(String(process.env.CLEAN_BRIDGE_USE_NATIVE_CTRL_O || ""));
const CDP_COMMAND_TIMEOUT_MS = Math.max(1000, Number(process.env.CLEAN_BRIDGE_CDP_TIMEOUT_MS || 60000));
const CDP_CONNECT_ATTEMPTS = Math.max(1, Number(process.env.CLEAN_BRIDGE_CDP_CONNECT_ATTEMPTS || 2));
const INSERT_CHUNK_CHARS = Math.max(500, Number(process.env.CLEAN_BRIDGE_INSERT_CHUNK_CHARS || 8000));
const INSERT_VERIFY_TIMEOUT_MS = Math.max(1000, Number(process.env.CLEAN_BRIDGE_INSERT_VERIFY_TIMEOUT_MS || 120000));
const CHAT_START_TIMEOUT_MS = Math.max(1000, Number(process.env.CLEAN_BRIDGE_CHAT_START_TIMEOUT_MS || 120000));
const ANSWER_NO_OUTPUT_TIMEOUT_MS = Math.max(1000, Number(process.env.CLEAN_BRIDGE_ANSWER_NO_OUTPUT_TIMEOUT_MS || 180000));
const OWNED_CHAT_REACQUIRE_ATTEMPTS = Math.max(0, Number(process.env.CLEAN_BRIDGE_OWNED_CHAT_REACQUIRE_ATTEMPTS || 3));
const CLIPBOARD_FALLBACK_ENABLED = /^(1|true|yes)$/i.test(String(process.env.CLEAN_BRIDGE_CLIPBOARD_FALLBACK || ""));
const CLIPBOARD_ATTEMPTS = Math.max(1, Number(process.env.CLEAN_BRIDGE_CLIPBOARD_ATTEMPTS || 3));

let activeRequests = 0;
const requestQueue = [];
const activeTargetIds = new Set();
const activeJobs = new Map();
let targetCreationChain = Promise.resolve();
let requestCounter = 0;
let lastArtifactPath = null;
let lastCompletedAt = null;
let lastError = null;
let lastCleanupAt = null;
let lastCleanupResult = null;
let cleanupPromise = null;
let overlaySweepPromise = null;
let lastOverlaySweepAt = null;
let lastOverlayDismissedAt = null;
let overlaysDismissed = 0;
let transportDegraded = false;
let lastTransportError = null;
let lastTransportRecoveryAt = null;
const quarantinedTargetIds = new Set();

function log(message, extra) {
  const stamp = new Date().toISOString();
  if (extra === undefined) {
    console.log(`[${stamp}] ${message}`);
  } else {
    console.log(`[${stamp}] ${message}`, extra);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function visibleEnabledButtonState(entry) {
  if (!entry) {
    return { found: false, visible: false, enabled: false, active: false };
  }
  const disabled = !!entry.disabled;
  const ariaDisabled = String(entry.ariaDisabled || "").trim() === "true";
  const visible = !!entry.visible;
  const enabled = visible && !disabled && !ariaDisabled;
  return {
    found: !!entry.found,
    visible,
    enabled,
    active: enabled
  };
}

function looksLikeCompleteJsonArtifact(text) {
  const value = String(text || "").trim();
  if (!value || !/^[{\[]/.test(value)) {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch (_error) {
    return false;
  }
}

function nextRequestId() {
  requestCounter += 1;
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(requestCounter).padStart(4, "0")}`;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function pumpQueue() {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && requestQueue.length > 0) {
    const job = requestQueue.shift();
    job.started = true;
    activeRequests += 1;
    job.run()
      .then(job.resolve, job.reject)
      .finally(() => {
        activeRequests -= 1;
        pumpQueue();
        scheduleIdleCleanup();
      });
  }
}

function scheduleIdleCleanup() {
  if (activeRequests > 0 || requestQueue.length > 0 || cleanupPromise) {
    return cleanupPromise;
  }
  cleanupPromise = cleanupInactiveAiTargets()
    .then((result) => {
      lastCleanupAt = new Date().toISOString();
      lastCleanupResult = result;
      return result;
    })
    .catch((error) => {
      lastCleanupAt = new Date().toISOString();
      lastCleanupResult = { closed: 0, error: String(error?.message || error) };
      return lastCleanupResult;
    })
    .finally(() => {
      cleanupPromise = null;
    });
  return cleanupPromise;
}

function scheduleOverlaySweep() {
  if (overlaySweepPromise) {
    return overlaySweepPromise;
  }
  overlaySweepPromise = dismissKnownOverlaysAcrossTargets()
    .then((result) => {
      lastOverlaySweepAt = new Date().toISOString();
      if (result.clicked > 0) {
        overlaysDismissed += result.clicked;
        lastOverlayDismissedAt = lastOverlaySweepAt;
        log("Dismissed blocking Notion overlay", result);
      }
      return result;
    })
    .catch((error) => {
      lastOverlaySweepAt = new Date().toISOString();
      return { clicked: 0, error: String(error?.message || error) };
    })
    .finally(() => {
      overlaySweepPromise = null;
    });
  return overlaySweepPromise;
}

function scheduleRequest(run, req = null) {
  if (requestQueue.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new Error("notion_clean_bridge_queue_full"));
  }
  return new Promise((resolve, reject) => {
    const job = { run, resolve, reject, queuedAt: Date.now(), started: false };
    const removeQueuedJob = () => {
      if (job.started) {
        return;
      }
      const index = requestQueue.indexOf(job);
      if (index >= 0) {
        requestQueue.splice(index, 1);
        reject(new Error("client_disconnected_before_provider_start"));
      }
    };
    if (req) {
      req.once("aborted", removeQueuedJob);
    }
    requestQueue.push(job);
    pumpQueue();
  });
}

function withTimeout(promise, timeoutMs, message) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function normalizeForMatch(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    // Notion sometimes flattens fenced blocks like "```text\nWould..."
    // into "```textWould...". Strip the fence marker and known language
    // tag without eating the first real content token.
    .replace(/```(?:text|txt|json|md|markdown|yaml|yml|xml|html|js|jsx|ts|tsx|bash|sh|python|py)(?=[A-Z{\[])/g, "")
    .replace(/```[a-zA-Z0-9_-]*(?:\r?\n|$)/g, "")
    .replace(/```/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*\[[ xX]\]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    // Notion may flatten rich list blocks into inline text such as
    // "Inputs include:- first- second". Match semantic words, not the
    // punctuation and block formatting chosen by either representation.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const NORMALIZE_FOR_MATCH_BROWSER_SOURCE = `function normalizeForMatchBrowser(value) {
  return String(value || "")
    .replace(/\\r\\n/g, "\\n")
    .replace(/\\\`\\\`\\\`(?:text|txt|json|md|markdown|yaml|yml|xml|html|js|jsx|ts|tsx|bash|sh|python|py)(?=[A-Z{\\[])/g, "")
    .replace(/\\\`\\\`\\\`[a-zA-Z0-9_-]*(?:\\r?\\n|$)/g, "")
    .replace(/\`\`\`/g, "")
    .replace(/\`([^\`]*)\`/g, "$1")
    .replace(/!\\[([^\\]]*)\\]\\([^)]+\\)/g, "$1")
    .replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, "$1")
    .replace(/^\\s{0,3}#{1,6}\\s+/gm, "")
    .replace(/^\\s{0,3}>\\s?/gm, "")
    .replace(/^\\s{0,3}([-*_])(?:\\s*\\1){2,}\\s*$/gm, "")
    .replace(/^\\s*[-*+]\\s+/gm, "")
    .replace(/^\\s*\\d+[.)]\\s+/gm, "")
    .replace(/^\\s*\\[[ xX]\\]\\s+/gm, "")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "$1")
    .replace(/\\*([^*\\n]+)\\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/[^\\p{L}\\p{N}]+/gu, " ")
    .replace(/\\s+/g, " ")
    .trim()
    .toLowerCase();
}`;

function promptNeedle(prompt) {
  const promptText = String(prompt || "");
  const userMatch = promptText.match(/(?:^|\n)user:\n([\s\S]*?)(?=\n(?:system|assistant|requested_output_contract):\n|$)/i);
  const userPart = userMatch?.[1] || promptText;
  const normalized = normalizeForMatch(userPart);
  return normalized.slice(0, 512);
}

function requestMarker(requestId) {
  return `BRIDGEREQUESTID ${String(requestId || "").replace(/[^A-Za-z0-9]/g, "").slice(-24)}`;
}

function addRequestMarkerToPrompt(prompt, marker) {
  const source = String(prompt || "");
  if (!marker || source.includes(marker)) {
    return source;
  }
  const firstBlank = source.indexOf("\n\n");
  if (firstBlank >= 0) {
    return `${source.slice(0, firstBlank)}\n${marker}${source.slice(firstBlank)}`;
  }
  return `${marker}\n${source}`;
}

function promptAnchors(prompt, marker = "") {
  const source = String(prompt || "");
  const anchors = [];
  if (marker) {
    anchors.push({ type: "request_marker", value: normalizeForMatch(marker) });
  }
  const userMatch = source.match(/(?:^|\n)user:\n([\s\S]*?)(?=\n(?:system|assistant|requested_output_contract):\n|$)/i);
  const userPart = userMatch?.[1] || source;
  const userLines = userPart
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:[-*]|\d+[.)])\s*$/.test(line));
  for (const line of userLines.slice(0, 8)) {
    const normalized = normalizeForMatch(line).slice(0, 160);
    if (normalized.length >= 24) {
      anchors.push({ type: "latest_user_anchor", value: normalized });
      break;
    }
  }
  const schemaMatch = source.match(/requested_output_contract:\s*([\s\S]{0,800})$/i);
  if (schemaMatch) {
    const normalized = normalizeForMatch(schemaMatch[1]).slice(0, 200);
    if (normalized.length >= 24) {
      anchors.push({ type: "schema_anchor", value: normalized });
    }
  }
  const responseMarker = normalizeForMatch("Thought");
  if (responseMarker) {
    anchors.push({ type: "response_marker", value: responseMarker });
  }
  return anchors;
}

function bodyContainsPrompt(body, needle) {
  if (!needle) {
    return true;
  }
  return normalizeForMatch(body).includes(needle);
}

function promptCorrelation(body, prompt, marker = "") {
  const normalizedBody = normalizeForMatch(body);
  const needle = promptNeedle(prompt);
  const matchedPrompt = !!needle && normalizedBody.includes(normalizeForMatch(needle));
  const anchors = promptAnchors(prompt, marker).map((anchor) => ({
    type: anchor.type,
    matched: !!anchor.value && normalizedBody.includes(anchor.value)
  }));
  const markerMatched = anchors.some((anchor) => anchor.type === "request_marker" && anchor.matched);
  const userAnchorMatched = anchors.some((anchor) => anchor.type === "latest_user_anchor" && anchor.matched);
  const schemaAnchorMatched = anchors.some((anchor) => anchor.type === "schema_anchor" && anchor.matched);
  const responseMarkerMatched = anchors.some((anchor) => anchor.type === "response_marker" && anchor.matched);
  return {
    matchedPrompt,
    markerMatched,
    userAnchorMatched,
    schemaAnchorMatched,
    responseMarkerMatched,
    anchors
  };
}

function visibleOutputEvidence(body) {
  const text = String(body || "");
  const candidate = cleanText(extractBodyAnswer(text));
  const bodyHasThought = /\nThought\n/.test(text);
  const bodyHasModelFooter = /\n(?:Sonnet|Opus|Claude|GPT|Gemini)\s/i.test(text);
  const completeJsonArtifact = looksLikeCompleteJsonArtifact(candidate);
  return {
    bodyHasThought,
    bodyHasModelFooter,
    candidate,
    candidateLength: candidate.length,
    completeJsonArtifact,
    visibleOutput: !!candidate || (bodyHasThought && bodyHasModelFooter)
  };
}

function ownershipSnapshot(body, prompt, marker = "") {
  const correlation = promptCorrelation(body, prompt, marker);
  const output = visibleOutputEvidence(body);
  let ownershipConfidence = "weak";
  if (correlation.markerMatched || correlation.matchedPrompt) {
    ownershipConfidence = "strong";
  } else if (correlation.userAnchorMatched || correlation.schemaAnchorMatched) {
    ownershipConfidence = "medium";
  } else if (output.visibleOutput) {
    ownershipConfidence = "recovered_visible_output";
  }
  return {
    ...correlation,
    ...output,
    ownershipConfidence
  };
}

function ownershipConfidenceRank(confidence) {
  switch (confidence) {
    case "strong":
      return 4;
    case "medium":
      return 3;
    case "recovered_visible_output":
      return 2;
    case "weak":
      return 1;
    default:
      return 0;
  }
}

function mergeOwnershipEvidence(current, next) {
  if (!current) {
    return next || null;
  }
  if (!next) {
    return current;
  }
  return ownershipConfidenceRank(next.ownershipConfidence) >= ownershipConfidenceRank(current.ownershipConfidence)
    ? next
    : current;
}

function chunkPromptText(text, chunkSize = INSERT_CHUNK_CHARS) {
  const source = String(text || "");
  const size = Math.max(1, Number(chunkSize || INSERT_CHUNK_CHARS));
  const chunks = [];
  for (let index = 0; index < source.length; index += size) {
    chunks.push(source.slice(index, index + size));
  }
  return chunks.length ? chunks : [""];
}

function composerLooksClipped(prompt, state) {
  return false;
}

function composerMismatchError(prompt, state, transport) {
  const inputLength = Number(state?.inputLength || 0);
  const error = new Error(`composer_insert_mismatch: expected ${String(prompt || "").length} source characters, received ${inputLength} rendered characters via ${transport}.`);
  error.transport = transport;
  error.promptLength = String(prompt || "").length;
  error.inputLength = inputLength;
  return error;
}

function shouldAttemptSubmitAfterInsert(state, elapsedMs, timeoutMs) {
  return Number(timeoutMs || 0) > 0
    && Number(elapsedMs || 0) >= Number(timeoutMs || 0)
    && Number(state?.inputLength || 0) > 0
    && !state?.submitReady
    && !String(state?.url || "").includes("notion.so/chat");
}

function promptContainsCandidate(prompt, candidate) {
  const normalizedCandidate = normalizeForMatch(candidate);
  if (!normalizedCandidate || normalizedCandidate.length < 12) {
    return true;
  }
  return normalizeForMatch(prompt).includes(normalizedCandidate);
}

function updateActiveJob(artifact, phase, extra = {}) {
  if (!artifact?.requestId || !activeJobs.has(artifact.requestId)) {
    return;
  }
  const current = activeJobs.get(artifact.requestId);
  activeJobs.set(artifact.requestId, {
    ...current,
    phase,
    updatedAt: new Date().toISOString(),
    ...extra
  });
}

function activeJobSnapshot() {
  const now = Date.now();
  return Array.from(activeJobs.values()).map((job) => ({
    ...job,
    ageMs: now - job.startedMs
  }));
}

function queuedJobSnapshot() {
  const now = Date.now();
  return requestQueue.map((job, index) => ({
    index,
    queuedMs: now - job.queuedAt
  }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (MAX_BODY_BYTES > 0 && body.length > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_error) {
        reject(new Error("Invalid JSON payload."));
      }
    });
    req.on("error", reject);
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function launchNotionIfNeeded() {
  if (!fs.existsSync(NOTION_EXE)) {
    throw new Error(`Notion.exe not found at ${NOTION_EXE}`);
  }

  const existing = childProcess.execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Notion.exe' -and $_.CommandLine -match '--remote-debugging-port=${DEBUG_PORT}' } | Select-Object -ExpandProperty ProcessId`
    ],
    { encoding: "utf8" }
  ).trim();

  if (existing) {
    return Number(existing.split(/\r?\n/)[0]);
  }

  try {
    childProcess.execFileSync("taskkill", ["/IM", "Notion.exe", "/F", "/T"], { encoding: "utf8" });
  } catch (_error) {
  }

  const started = childProcess.execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$p = Start-Process -FilePath '${NOTION_EXE.replace(/'/g, "''")}' -ArgumentList @('--remote-debugging-port=${DEBUG_PORT}') -PassThru; $p.Id`
    ],
    { encoding: "utf8" }
  ).trim();
  return Number(started.split(/\r?\n/)[0]);
}

function restartNotionForTransportRecovery(reason) {
  log("Restarting Notion after CDP transport failure", reason);
  try {
    childProcess.execFileSync("taskkill", ["/IM", "Notion.exe", "/F", "/T"], { encoding: "utf8" });
  } catch (_error) {
  }
  quarantinedTargetIds.clear();
  const pid = launchNotionIfNeeded();
  transportDegraded = false;
  lastTransportRecoveryAt = new Date().toISOString();
  return pid;
}

async function waitForDebugTargets() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const targets = await fetchJson(`http://${HOST}:${DEBUG_PORT}/json/list`);
      if (Array.isArray(targets) && targets.length) {
        return targets;
      }
    } catch (_error) {
    }
    await delay(500);
  }
  throw new Error("Notion debug endpoint did not become ready.");
}

async function createFreshTarget() {
  const previous = targetCreationChain;
  let releaseLock = null;
  targetCreationChain = new Promise((resolve) => {
    releaseLock = resolve;
  });

  await previous.catch(() => {});
  try {
    launchNotionIfNeeded();
    const beforeTargets = await waitForDebugTargets();
    const beforeIds = new Set(beforeTargets.map((target) => target.id).filter(Boolean));
    const seedTarget = pickPageTarget(beforeTargets);
    if (!seedTarget) {
      throw new Error("No seed Notion target available for tab creation.");
    }

    const seedClient = createCdpClient(seedTarget.webSocketDebuggerUrl);
    try {
      await seedClient.open;
      await seedClient.send("Runtime.enable");
      await evaluate(
        seedClient,
        `(() => {
          window.open(${JSON.stringify(NOTION_URL)}, '_blank');
          return true;
        })()`
      );
    } finally {
      seedClient.close();
    }

    const started = Date.now();
    while (Date.now() - started < 10000) {
      const targets = await waitForDebugTargets();
      const fresh = targets.find((target) =>
        target &&
        target.type === "page" &&
        target.webSocketDebuggerUrl &&
        target.id &&
        !beforeIds.has(target.id)
      );
      if (fresh) {
        return fresh;
      }
      await delay(300);
    }
    throw new Error("Timed out creating isolated Notion tab target.");
  } finally {
    if (releaseLock) {
      releaseLock();
    }
  }
}

async function closeTarget(targetId) {
  if (!targetId) {
    return;
  }
  try {
    await fetch(`http://${HOST}:${DEBUG_PORT}/json/close/${encodeURIComponent(targetId)}`);
  } catch (_error) {
  }
}

async function listDebugTargetsQuick() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`http://${HOST}:${DEBUG_PORT}/json/list`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      return [];
    }
    const targets = await response.json();
    return Array.isArray(targets) ? targets : [];
  } catch (_error) {
    return [];
  }
}

async function cleanupInactiveAiTargets() {
  if (activeRequests > 0 || requestQueue.length > 0) {
    return { closed: 0, remaining: null, skipped: "bridge_not_idle" };
  }
  const targets = await listDebugTargetsQuick();
  if (!targets.length) {
    return { closed: 0, remaining: null, skipped: "debug_unavailable" };
  }
  const tabBar = targets.find((target) =>
    target?.type === "page" &&
    target.webSocketDebuggerUrl &&
    String(target.url || "").includes("/renderer/tabs/")
  );
  if (!tabBar) {
    return { closed: 0, remaining: null, skipped: "tab_bar_unavailable" };
  }

  const client = createCdpClient(tabBar.webSocketDebuggerUrl);
  try {
    await client.open;
    await client.send("Runtime.enable");
    let closed = 0;
    while (true) {
      const state = await evaluate(client, `(() => {
        const buttons = Array.from(document.querySelectorAll('[role="button"][aria-label^="Close Tab,"]'));
        const rect = buttons[0]?.getBoundingClientRect();
        return {
          count: buttons.length,
          first: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
        };
      })()`);
      if (!state?.first || state.count <= MAX_RETAINED_TABS) {
        return { closed, remaining: state?.count ?? null, retainedLimit: MAX_RETAINED_TABS };
      }
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: state.first.x,
        y: state.first.y,
        button: "left",
        clickCount: 1
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: state.first.x,
        y: state.first.y,
        button: "left",
        clickCount: 1
      });
      closed += 1;
      await delay(200);
    }
  } finally {
    client.close();
  }
}

async function dismissKnownOverlaysAcrossTargets() {
  const targets = (await listDebugTargetsQuick()).filter((target) =>
    target?.type === "page" &&
    target.webSocketDebuggerUrl &&
    String(target.url || "").startsWith("https://www.notion.so/")
  );
  let clicked = 0;
  let scanned = 0;
  for (const target of targets) {
    const client = createCdpClient(target.webSocketDebuggerUrl);
    try {
      await client.open;
      await client.send("Runtime.enable");
      scanned += 1;
      for (let pass = 0; pass < 3; pass += 1) {
        const match = await evaluate(client, `(() => {
          const button = Array.from(document.querySelectorAll('[role="button"], button')).find((node) => {
            const text = (node.innerText || '').replace(/\\s+/g, ' ').trim().toLowerCase();
            const rect = node.getBoundingClientRect();
            return text === 'got it' && rect.width > 0 && rect.height > 0;
          });
          if (!button) return null;
          const rect = button.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        if (!match) {
          break;
        }
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: match.x,
          y: match.y,
          button: "left",
          clickCount: 1
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: match.x,
          y: match.y,
          button: "left",
          clickCount: 1
        });
        clicked += 1;
        await delay(200);
      }
    } catch (_error) {
    } finally {
      client.close();
    }
  }
  return { clicked, scanned };
}

async function findAnswerInExistingChats(prompt, artifact) {
  if (!ALLOW_STALE_RECOVERY) {
    return "";
  }
  const matched = await findMatchingChatTarget(prompt, artifact, { requireCandidate: true });
  return matched?.candidate || "";
}

async function findMatchingChatTarget(prompt, artifact, options = {}) {
  if (!ALLOW_STALE_RECOVERY) {
    return null;
  }
  const requireCandidate = !!options.requireCandidate;
  const needle = promptNeedle(prompt);
  const promptNorm = normalizeForMatch(prompt);
  const targets = (await listDebugTargetsQuick()).filter((target) =>
    target &&
    target.type === "page" &&
    target.webSocketDebuggerUrl &&
    String(target.url || "").includes("notion.so/chat")
  );
  for (const target of targets) {
    const client = createCdpClient(target.webSocketDebuggerUrl);
    try {
      await client.open;
      await client.send("Runtime.enable");
      const state = await evaluate(
        client,
        `(() => {
          ${NORMALIZE_FOR_MATCH_BROWSER_SOURCE}
          const normalize = normalizeForMatchBrowser;
          const body = document.body ? document.body.innerText : '';
          const matchedPrompt = normalize(body).includes(${JSON.stringify(needle)});
          const promptNorm = ${JSON.stringify(promptNorm)};
          const clean = (text) => String(text || '').replace(/\\r\\n/g, '\\n').trim();
          const promptContains = (text) => {
            const normalized = normalize(text);
            return !normalized || normalized.length < 12 || promptNorm.includes(normalized);
          };
          const roots = Array.from(document.querySelectorAll('[data-content-editable-root="true"], [role="group"]'))
            .map((el) => clean((el.innerText || '').replace(/\\r/g, '')))
            .filter((text) => text && !/^(?:Sonnet|Opus|Claude|GPT|Gemini)\\s+/i.test(text))
            .filter((text) => !promptContains(text));
          const bodyAnswer = (() => {
            const chunks = body.split(/\\nThought\\n/);
            if (chunks.length < 2) return '';
            return clean(chunks[chunks.length - 1]
              .split(/\\n(?:Sonnet|Opus|Claude|GPT|Gemini)\\s/i)[0]
              .replace(/\\nNotion AI finished\\.?$/i, ''));
          })();
          const rawCandidate = bodyAnswer || (roots.length ? roots[roots.length - 1] : '');
          const candidate = matchedPrompt && (bodyAnswer || !promptContains(rawCandidate)) ? rawCandidate : '';
          return {
            title: document.title,
            url: location.href,
            matchedPrompt,
            candidate,
            candidateLength: candidate.length,
            body
          };
        })()`
      );
      if (state?.candidate) {
        artifact.events.push({
          at: new Date().toISOString(),
          state: "answer_recovered_from_existing_chat",
          snapshot: { targetId: target.id, title: state.title, url: state.url, candidateLength: state.candidateLength }
        });
        return { target, state, candidate: state.candidate };
      }
      if (state?.matchedPrompt && !requireCandidate) {
        artifact.events.push({
          at: new Date().toISOString(),
          state: "matching_chat_target_found",
          snapshot: { targetId: target.id, title: state.title, url: state.url, candidateLength: state.candidateLength }
        });
        return { target, state, candidate: "" };
      }
    } catch (_error) {
    } finally {
      client.close();
    }
  }
  return null;
}

function pickPageTarget(targets) {
  const pages = Array.isArray(targets)
    ? targets.filter((target) => target && target.type === "page" && target.webSocketDebuggerUrl && !quarantinedTargetIds.has(target.id))
    : [];
  return (
    [...pages].reverse().find((target) => String(target.url || "").includes("notion.so/ai")) ||
    [...pages].reverse().find((target) => String(target.url || "").includes("notion.so/chat")) ||
    [...pages].reverse().find((target) => String(target.url || "").includes("notion.so")) ||
    pages[0]
  );
}

function createCdpClient(webSocketDebuggerUrl) {
  let id = 0;
  let closed = false;
  const pending = new Map();
  const ws = new WebSocket(webSocketDebuggerUrl);

  const open = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP websocket open failed."));
  });

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) {
      return;
    }
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(msg.error.message || "CDP error"));
    } else {
      entry.resolve(msg);
    }
  };

  ws.onclose = () => {
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CDP websocket closed."));
    }
    pending.clear();
  };

  async function send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
    await open;
    if (closed) {
      throw new Error("CDP websocket is closed.");
    }
    return new Promise((resolve, reject) => {
      const msgId = ++id;
      const timer = setTimeout(() => {
        pending.delete(msgId);
        reject(new Error(`CDP timeout on ${method}`));
      }, timeoutMs);
      pending.set(msgId, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  return {
    open,
    send,
    close() {
      if (!closed) {
        ws.close();
      }
    }
  };
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return response.result?.result?.value;
}

function isCdpTransportError(error) {
  const message = String(error?.message || error || "");
  return /CDP timeout on|CDP websocket|websocket|Notion debug endpoint|No Notion page target|No seed Notion target|Set-Clipboard|Clipboard operation|Input\.insertText|composer_clear_failed|composer_insert_mismatch|composer_submit_not_ready_after_insert|chat_start_timeout_after_submit|answer_no_output_timeout_after_submit|owned_chat_reacquire_failed|Owned chat changed|Owned Notion target left chat page|client_disconnected_before_provider_start|Could not focus Notion composer/i.test(message);
}

async function probeCdpTarget(target) {
  const client = createCdpClient(target.webSocketDebuggerUrl);
  try {
    await client.open;
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    const probe = await evaluate(
      client,
      `(() => ({ href: location.href, title: document.title, readyState: document.readyState, bodyLen: document.body ? document.body.innerText.length : 0 }))()`
    );
    return { client, probe };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function connectNotionPage(artifact = null) {
  let lastConnectError = null;
  for (let attempt = 1; attempt <= CDP_CONNECT_ATTEMPTS; attempt += 1) {
    launchNotionIfNeeded();
    const targets = await waitForDebugTargets();
    const target = pickPageTarget(targets);
    if (!target) {
      lastConnectError = new Error("No Notion page target available.");
    } else {
      try {
        const { client, probe } = await probeCdpTarget(target);
        transportDegraded = false;
        lastTransportError = null;
        if (artifact) {
          artifact.events.push({
            at: new Date().toISOString(),
            state: "cdp_probe_ready",
            snapshot: { attempt, targetId: target.id, url: target.url, probe }
          });
        }
        return { client, target, probe };
      } catch (error) {
        lastConnectError = error;
        if (target.id) {
          quarantinedTargetIds.add(target.id);
        }
        transportDegraded = true;
        lastTransportError = String(error?.message || error);
        if (artifact) {
          artifact.events.push({
            at: new Date().toISOString(),
            state: "cdp_probe_failed",
            snapshot: { attempt, targetId: target.id, url: target.url, error: lastTransportError }
          });
        }
      }
    }

    if (attempt < CDP_CONNECT_ATTEMPTS && isCdpTransportError(lastConnectError)) {
      restartNotionForTransportRecovery(lastTransportError || lastConnectError.message);
      await delay(2500);
      continue;
    }
    break;
  }
  throw lastConnectError || new Error("Unable to connect to Notion CDP target.");
}

async function readinessProbe() {
  launchNotionIfNeeded();
  const targets = await waitForDebugTargets();
  const target = pickPageTarget(targets);
  if (!target) {
    throw new Error("No Notion page target available.");
  }
  const { client, probe } = await probeCdpTarget(target);
  client.close();
  return { target, probe, targetCount: targets.length };
}

async function readinessComposerProbe() {
  const connected = await connectNotionPage();
  const client = connected.client;
  try {
    await gotoAiHome(client, { events: [] });
    await dismissOverlays(client, { events: [] });
    await waitForComposer(client, { events: [], requestId: "" });
    const focused = await focusComposer(client);
    const cleared = await clearComposer(client);
    return {
      ok: !!focused?.ok && !cleared?.inputLength,
      focused,
      inputLength: cleared?.inputLength || 0,
      target: { id: connected.target?.id, title: connected.target?.title, url: connected.target?.url }
    };
  } finally {
    client.close();
  }
}

async function gotoAiHome(client, artifact) {
  await client.send("Page.navigate", { url: NOTION_URL });
  await delay(4500);
  const state = await snapshot(client);
  artifact.events.push({ at: new Date().toISOString(), state: "navigated", snapshot: state });
  return state;
}

async function snapshot(client) {
  return evaluate(
    client,
    `(() => ({
      title: document.title,
      url: location.href,
      body: document.body ? document.body.innerText : "",
      inputs: Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input')).map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          role: node.getAttribute('role') || '',
          placeholder: node.getAttribute('placeholder') || '',
          text: (node.innerText || node.value || '').trim(),
          visible: rect.width > 0 && rect.height > 0
        };
      }),
      buttons: Array.from(document.querySelectorAll('[role="button"], button')).map((el) => ({
        aria: (el.getAttribute('aria-label') || '').trim(),
        text: (el.innerText || '').trim(),
        disabled: !!el.disabled,
        ariaDisabled: (el.getAttribute('aria-disabled') || '').trim(),
        testId: (el.getAttribute('data-testid') || '').trim()
      })).filter((entry) => entry.aria || entry.text)
    }))()`
  );
}

async function dismissOverlays(client, artifact) {
  const clicked = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const result = await evaluate(
      client,
      `(() => {
        const clicked = [];
        const buttons = Array.from(document.querySelectorAll('[role="button"], button'));
        for (const button of buttons) {
          const text = (button.innerText || '').trim();
          const rect = button.getBoundingClientRect();
          if (text === 'Got it' && rect.width > 0 && rect.height > 0) {
            button.click();
            clicked.push(text);
          }
        }
        return { clicked };
      })()`
    );
    if (!result?.clicked?.length) {
      break;
    }
    clicked.push(...result.clicked);
    await delay(500);
  }
  if (clicked.length) {
    artifact.events.push({ at: new Date().toISOString(), state: "overlays_dismissed", snapshot: { clicked } });
  }
}

async function waitForComposer(client, artifact) {
  const started = Date.now();
  let last = null;
  let lastEventAt = 0;
  while (true) {
    updateActiveJob(artifact, "waiting_for_composer", { stageAgeMs: Date.now() - started });
    last = await snapshot(client);
    const ready = Array.isArray(last.inputs) && last.inputs.some((input) => {
      const placeholder = String(input.placeholder || "").toLowerCase();
      return input.visible && (input.role === "textbox" || placeholder.includes("ai"));
    });
    if (ready) {
      artifact.events.push({ at: new Date().toISOString(), state: "composer_ready", snapshot: last });
      updateActiveJob(artifact, "composer_ready");
      return;
    }
    if (Date.now() - lastEventAt >= 30000) {
      artifact.events.push({ at: new Date().toISOString(), state: "composer_waiting", snapshot: last });
      lastEventAt = Date.now();
    }
    await dismissOverlays(client, artifact);
    await delay(1000);
  }
}

function setClipboard(text) {
  const filePath = path.join(os.tmpdir(), `notion-clean-clipboard-${Date.now()}.txt`);
  fs.writeFileSync(filePath, String(text || ""), "utf8");
  try {
    childProcess.execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$v = [System.IO.File]::ReadAllText('${filePath.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8); Set-Clipboard -Value $v`
      ],
      { encoding: "utf8" }
    );
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch (_error) {
    }
  }
}

function activateNotionWindow() {
  try {
    childProcess.execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        [
          "Add-Type -TypeDefinition @'",
          "using System;",
          "using System.Runtime.InteropServices;",
          "public static class NotionWindow {",
          "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
          "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
          "}",
          "'@;",
          "$p = Get-Process Notion -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;",
          "if (-not $p) { exit 0 };",
          "[void][NotionWindow]::ShowWindowAsync($p.MainWindowHandle, 9);",
          "[void][NotionWindow]::SetForegroundWindow($p.MainWindowHandle)"
        ].join("\n")
      ],
      { encoding: "utf8" }
    );
    return true;
  } catch (_error) {
    return false;
  }
}

async function focusComposer(client) {
  return evaluate(
    client,
    `(() => {
      const input = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input'))
        .find((node) => {
          const placeholder = (node.getAttribute('placeholder') || '').toLowerCase();
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (placeholder.includes('ai') || node.getAttribute('role') === 'textbox');
        });
      if (!input) return { ok: false };
      input.focus();
      input.click();
      if (input.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete');
      } else {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const rect = input.getBoundingClientRect();
      const active = document.activeElement === input || input.contains(document.activeElement);
      return {
        ok: true,
        active,
        tag: input.tagName,
        role: input.getAttribute('role') || '',
        placeholder: input.getAttribute('placeholder') || '',
        isContentEditable: !!input.isContentEditable,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      };
    })()`
  );
}

async function pressCtrlV(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 2,
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    code: "KeyV",
    key: "v"
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    code: "KeyV",
    key: "v"
  });
}

async function pressCtrlKey(client, key, code, virtualKeyCode) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 2,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    code,
    key
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    code,
    key
  });
}

async function startNativeNewChat(client, artifact) {
  activateNotionWindow();
  await delay(300);
  pressOsCtrlO();
  await delay(1200);
  const state = await snapshot(client);
  artifact.events.push({ at: new Date().toISOString(), state: "native_new_chat_requested", snapshot: state });
  updateActiveJob(artifact, "native_new_chat_requested", { url: state.url, title: state.title });
  return state;
}

async function attachNewestNotionAiTarget(artifact) {
  const started = Date.now();
  let lastSeen = [];
  while (Date.now() - started < 30000) {
    const targets = await waitForDebugTargets();
    const candidates = targets.filter((target) =>
      target &&
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      String(target.url || "").startsWith("https://www.notion.so/ai")
    );
    lastSeen = candidates.map((target) => ({ id: target.id, title: target.title, url: target.url }));
    for (const target of candidates) {
      const nextClient = createCdpClient(target.webSocketDebuggerUrl);
      try {
        await nextClient.open;
        await nextClient.send("Runtime.enable");
        await nextClient.send("Page.enable");
        const state = await snapshot(nextClient);
        const hasComposer = Array.isArray(state.inputs) && state.inputs.some((input) => {
          const placeholder = String(input.placeholder || "").toLowerCase();
          return input.visible && (input.role === "textbox" || placeholder.includes("ai"));
        });
        const body = String(state.body || "");
        const freshEnough = hasComposer && !/\nThought\n/.test(body) && !body.includes("Notion AI finished");
        if (freshEnough) {
          artifact.events.push({
            at: new Date().toISOString(),
            state: "attached_after_native_new_chat",
            snapshot: { ...target, ownedSurface: { url: state.url, title: state.title } }
          });
          updateActiveJob(artifact, "attached_after_native_new_chat", { targetId: target.id, url: state.url, title: state.title });
          return { client: nextClient, target };
        }
      } catch (_error) {
      }
      nextClient.close();
    }
    await delay(500);
  }
  throw new Error(`No fresh Notion AI composer target available after native new chat. Candidates: ${JSON.stringify(lastSeen)}`);
}

function pressOsCtrlO() {
  childProcess.execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$ws = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 100; $ws.SendKeys('^o')"
    ],
    { encoding: "utf8" }
  );
}

async function clearComposer(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    code: "KeyA",
    key: "a"
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    code: "KeyA",
    key: "a"
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
    code: "Backspace",
    key: "Backspace"
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
    code: "Backspace",
    key: "Backspace"
  });
  await delay(300);
  const state = await inputState(client);
  if (!state?.inputLength) {
    return state;
  }
  const domCleared = await evaluate(
    client,
    `(() => {
      const input = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input'))
        .find((node) => {
          const placeholder = (node.getAttribute('placeholder') || '').toLowerCase();
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (placeholder.includes('ai') || node.getAttribute('role') === 'textbox');
        });
      if (!input) return { ok: false, reason: 'composer_missing' };
      input.focus();
      if (input.isContentEditable) {
        input.textContent = '';
        input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      } else {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`
  );
  await delay(300);
  const after = await inputState(client);
  if (after?.inputLength) {
    const error = new Error(`composer_clear_failed: ${after.inputLength} characters remain after keyboard and DOM clear.`);
    error.transport = "composer_clear";
    error.inputLength = after.inputLength;
    error.domCleared = domCleared;
    throw error;
  }
  return after;
}

async function inputState(client) {
  return evaluate(
    client,
    `(() => {
      const describeButton = (el) => {
        if (!el) {
          return { found: false, visible: false, disabled: false, ariaDisabled: '', enabled: false };
        }
        const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
        const visible = !!rect
          && rect.width > 0
          && rect.height > 0
          && (!style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'));
        const disabled = !!el.disabled;
        const ariaDisabled = (el.getAttribute('aria-disabled') || '').trim();
        const enabled = visible && !disabled && ariaDisabled !== 'true';
        return { found: true, visible, disabled, ariaDisabled, enabled };
      };
      const input = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input'))
        .find((node) => {
          const placeholder = (node.getAttribute('placeholder') || '').toLowerCase();
          return placeholder.includes('ai') || node.getAttribute('role') === 'textbox';
        });
      const buttons = Array.from(document.querySelectorAll('[role="button"], button'));
      const submitButtons = buttons.filter((el) => (el.getAttribute('aria-label') || '').trim() === 'Submit AI message');
      const stopButtons = buttons.filter((el) => (el.getAttribute('aria-label') || '').trim() === 'Stop AI message');
      const submit = submitButtons.map(describeButton).find((entry) => entry.enabled) || describeButton(submitButtons[0]);
      const stop = stopButtons.map(describeButton).find((entry) => entry.enabled) || describeButton(stopButtons[0]);
      const text = input ? (input.innerText || input.value || '').trim() : '';
      return {
        url: location.href,
        body: document.body ? document.body.innerText : '',
        inputLength: text.length,
        inputText: text,
        hasSubmit: submit.found,
        submitReady: submit.enabled,
        submitButtonVisible: submit.visible,
        submitButtonEnabled: submit.enabled,
        submitButtonCount: submitButtons.length,
        stopActive: stop.enabled,
        stopButtonVisible: stop.visible,
        stopButtonEnabled: stop.enabled,
        stopButtonCount: stopButtons.length
      };
    })()`
  );
}

async function verifyPromptInserted(client, prompt, artifact, transport, startedAt = Date.now()) {
  const started = Date.now();
  let state = null;
  let lastEventAt = 0;
  while (true) {
    updateActiveJob(artifact, "inserting_prompt", { transport, stageAgeMs: Date.now() - startedAt });
    state = await inputState(client);
    const alreadySubmitted = String(state?.url || '').includes('notion.so/chat')
      && bodyContainsPrompt(state?.body || '', promptNeedle(prompt))
      && (state?.stopActive || !state?.hasSubmit);
    if (alreadySubmitted) {
      artifact.events.push({ at: new Date().toISOString(), state: "prompt_already_submitted", snapshot: { transport, url: state.url, stopActive: state.stopActive } });
      updateActiveJob(artifact, "prompt_already_submitted", { transport, url: state.url });
      return { ...state, alreadySubmitted: true };
    }
    const inputMatches = normalizeForMatch(state?.inputText) === normalizeForMatch(prompt);
    if (inputMatches && state?.submitReady) {
      artifact.events.push({ at: new Date().toISOString(), state: "prompt_inserted", snapshot: { ...state, body: undefined, transport } });
      updateActiveJob(artifact, "prompt_inserted", { transport, inputLength: state.inputLength });
      return state;
    }
    if (state?.inputLength > 0 && !inputMatches && state?.submitReady) {
      artifact.events.push({
        at: new Date().toISOString(),
        state: "prompt_inserted_readback_mismatch_accepted",
        snapshot: {
          transport,
          promptLength: String(prompt || "").length,
          inputLength: state.inputLength,
          reason: "Rendered composer text is not authoritative for long Notion prompts; transport inserted text and composer is submit-ready."
        }
      });
      updateActiveJob(artifact, "prompt_inserted", { transport, inputLength: state.inputLength, readbackMismatchAccepted: true });
      return { ...state, readbackMismatchAccepted: true };
    }
    const elapsed = Date.now() - started;
    if (shouldAttemptSubmitAfterInsert(state, elapsed, INSERT_VERIFY_TIMEOUT_MS)) {
      artifact.events.push({
        at: new Date().toISOString(),
        state: "prompt_inserted_submit_not_ready",
        snapshot: {
          transport,
          promptLength: String(prompt || "").length,
          inputLength: state.inputLength,
          elapsedMs: elapsed,
          submitReady: state.submitReady,
          submitButtonVisible: state.submitButtonVisible,
          submitButtonEnabled: state.submitButtonEnabled
        }
      });
      updateActiveJob(artifact, "prompt_inserted_submit_not_ready", {
        transport,
        inputLength: state.inputLength,
        stageAgeMs: Date.now() - startedAt
      });
      return { ...state, needsSubmitFallback: true };
    }
    if (INSERT_VERIFY_TIMEOUT_MS > 0 && state?.inputLength > 0 && !inputMatches && elapsed > INSERT_VERIFY_TIMEOUT_MS) {
      throw composerMismatchError(prompt, state, transport);
    }
    if (INSERT_VERIFY_TIMEOUT_MS > 0 && elapsed > INSERT_VERIFY_TIMEOUT_MS && !state?.inputLength) {
      const error = new Error(`composer_insert_mismatch: no prompt text observed after ${transport} insertion.`);
      error.transport = transport;
      error.promptLength = String(prompt || "").length;
      error.inputLength = 0;
      throw error;
    }
    if (Date.now() - lastEventAt >= 5000) {
      artifact.events.push({ at: new Date().toISOString(), state: "insert_waiting", snapshot: { ...state, body: undefined, transport } });
      lastEventAt = Date.now();
    }
    await delay(500);
  }
}

async function insertPromptViaCdp(client, prompt, artifact) {
  const started = Date.now();
  const chunks = chunkPromptText(prompt, INSERT_CHUNK_CHARS);
  artifact.events.push({ at: new Date().toISOString(), state: "cdp_insert_started", snapshot: { chunks: chunks.length, chunkSize: INSERT_CHUNK_CHARS, promptLength: prompt.length } });
  let insertedChars = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    await client.send("Input.insertText", { text: chunk });
    insertedChars += chunk.length;
    updateActiveJob(artifact, "inserting_prompt", { transport: "cdp_insert_text", insertedChars, inputLength: insertedChars, stageAgeMs: Date.now() - started });
    if (index === 0 || index === chunks.length - 1 || (index + 1) % 5 === 0) {
      artifact.events.push({ at: new Date().toISOString(), state: "cdp_insert_chunk", snapshot: { index: index + 1, chunks: chunks.length, insertedChars } });
    }
    await delay(10);
  }
  const verified = await verifyPromptInserted(client, prompt, artifact, "cdp_insert_text", started);
  artifact.events.push({ at: new Date().toISOString(), state: "cdp_insert_verified", snapshot: { inputLength: verified.inputLength, promptLength: prompt.length } });
  return verified;
}

async function insertPromptViaDom(client, prompt, artifact) {
  artifact.events.push({ at: new Date().toISOString(), state: "dom_insert_started", snapshot: { promptLength: prompt.length } });
  const result = await evaluate(
    client,
    `(() => {
      const text = ${JSON.stringify(prompt)};
      const input = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input'))
        .find((node) => {
          const placeholder = (node.getAttribute('placeholder') || '').toLowerCase();
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (placeholder.includes('ai') || node.getAttribute('role') === 'textbox');
        });
      if (!input) return { ok: false, reason: 'composer_missing' };
      input.focus();
      if (input.isContentEditable) {
        input.textContent = text;
        input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } else {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, textLength: text.length };
    })()`
  );
  if (!result?.ok) {
    const error = new Error(`dom_editor_insert_failed: ${result?.reason || "unknown"}`);
    error.transport = "dom_editor_insert";
    throw error;
  }
  return verifyPromptInserted(client, prompt, artifact, "dom_editor_insert", Date.now());
}

async function insertPromptViaClipboard(client, prompt, artifact) {
  if (!CLIPBOARD_FALLBACK_ENABLED) {
    const error = new Error("clipboard_fallback_disabled");
    error.transport = "clipboard_paste";
    throw error;
  }
  artifact.events.push({ at: new Date().toISOString(), state: "clipboard_fallback_started", snapshot: { attempts: CLIPBOARD_ATTEMPTS, promptLength: prompt.length } });
  let lastError = null;
  for (let attempt = 1; attempt <= CLIPBOARD_ATTEMPTS; attempt += 1) {
    try {
      activateNotionWindow();
      await delay(250 * attempt);
      setClipboard(prompt);
      await focusComposer(client);
      await pressCtrlV(client);
      return await verifyPromptInserted(client, prompt, artifact, "clipboard_paste", Date.now());
    } catch (error) {
      lastError = error;
      artifact.events.push({ at: new Date().toISOString(), state: "clipboard_fallback_failed", snapshot: { attempt, error: String(error?.message || error) } });
      await delay(500 * attempt);
    }
  }
  throw lastError || new Error("clipboard_fallback_failed");
}

async function pastePrompt(client, prompt, artifact) {
  const started = Date.now();
  artifact.events.push({ at: new Date().toISOString(), state: "prompt_transport_started", snapshot: { primary: "cdp_insert_text", fallback: CLIPBOARD_FALLBACK_ENABLED ? "dom_editor_insert,clipboard_paste" : "dom_editor_insert", promptLength: prompt.length } });
  updateActiveJob(artifact, "inserting_prompt", { transport: "starting", stageAgeMs: 0, inputLength: 0, insertedChars: 0 });
  activateNotionWindow();
  await delay(100);
  const focused = await focusComposer(client);
  artifact.events.push({ at: new Date().toISOString(), state: "composer_focused", snapshot: focused });
  if (!focused?.ok) {
    throw new Error("Could not focus Notion composer.");
  }

  await clearComposer(client);
  const failures = [];
  for (const transport of [
    ["cdp_insert_text", insertPromptViaCdp],
    ["dom_editor_insert", insertPromptViaDom],
    ["clipboard_paste", insertPromptViaClipboard]
  ]) {
    const [name, fn] = transport;
    if (name === "clipboard_paste" && !CLIPBOARD_FALLBACK_ENABLED) {
      continue;
    }
    try {
      if (name !== "cdp_insert_text") {
        await clearComposer(client);
      }
      return await fn(client, prompt, artifact);
    } catch (error) {
      failures.push({ transport: name, error: String(error?.message || error) });
      artifact.events.push({ at: new Date().toISOString(), state: "prompt_transport_failed", snapshot: { transport: name, error: String(error?.message || error), failures } });
      if (composerLooksClipped(prompt, error)) {
        throw error;
      }
    }
  }
  const error = new Error(`prompt_transport_failed: ${failures.map((failure) => `${failure.transport}: ${failure.error}`).join(" | ")}`);
  error.transport = failures[failures.length - 1]?.transport || "unknown";
  error.failures = failures;
  error.stageAgeMs = Date.now() - started;
  throw error;
}

async function submit(client, artifact) {
  const clicked = await evaluate(
    client,
    `(() => {
      const submit = Array.from(document.querySelectorAll('[role="button"], button'))
        .find((el) => {
          const aria = (el.getAttribute('aria-label') || '').trim();
          const testId = (el.getAttribute('data-testid') || '').trim();
          return aria === 'Submit AI message' || testId === 'agent-send-message-button';
        });
      if (!submit) return { ok: false, reason: 'submit_missing' };
      if (submit.disabled || (submit.getAttribute('aria-disabled') || '').trim() === 'true') {
        return { ok: false, reason: 'submit_disabled' };
      }
      submit.click();
      return { ok: true, mode: 'click' };
    })()`
  );
  artifact.events.push({ at: new Date().toISOString(), state: "submitted", snapshot: clicked });
  if (clicked?.ok) {
    return;
  }
  const state = await inputState(client);
  if (!state?.inputLength) {
    const error = new Error(`composer_submit_not_ready_after_insert: submit failed before prompt was present: ${clicked?.reason || "unknown"}`);
    error.transport = "submit";
    error.inputLength = 0;
    throw error;
  }
  await focusComposer(client);
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  artifact.events.push({ at: new Date().toISOString(), state: "submitted_enter_fallback", snapshot: clicked });
}

async function waitForChatStarted(client, artifact, prompt) {
  const started = Date.now();
  let state = null;
  let lastEventAt = 0;
  while (true) {
    updateActiveJob(artifact, "waiting_for_chat_thread", { stageAgeMs: Date.now() - started });
    state = await evaluate(
      client,
      `(() => ({
        title: document.title,
        url: location.href,
        body: document.body ? document.body.innerText : ''
      }))()`
    );
    const ownership = ownershipSnapshot(state?.body || "", prompt, artifact.requestMarker);
    const isChat = String(state?.url || "").includes("notion.so/chat");
    if (isChat) {
      const eventState = ownership.visibleOutput && !ownership.matchedPrompt
        ? "owned_chat_recovered_from_visible_output"
        : "chat_started";
      const snapshot = {
        ...state,
        body: undefined,
        matchedPrompt: ownership.matchedPrompt,
        markerMatched: ownership.markerMatched,
        userAnchorMatched: ownership.userAnchorMatched,
        schemaAnchorMatched: ownership.schemaAnchorMatched,
        bodyHasThought: ownership.bodyHasThought,
        bodyHasModelFooter: ownership.bodyHasModelFooter,
        candidateLength: ownership.candidateLength,
        ownershipConfidence: ownership.ownershipConfidence
      };
      artifact.events.push({ at: new Date().toISOString(), state: eventState, snapshot });
      updateActiveJob(artifact, eventState, {
        url: state.url,
        matchedPrompt: ownership.matchedPrompt,
        ownershipConfidence: ownership.ownershipConfidence,
        candidateLength: ownership.candidateLength,
        bodyHasThought: ownership.bodyHasThought,
        bodyHasModelFooter: ownership.bodyHasModelFooter
      });
      return {
        ...state,
        ownership
      };
    }
    if (Date.now() - started > CHAT_START_TIMEOUT_MS) {
      const finalOwnership = ownershipSnapshot(state?.body || "", prompt, artifact.requestMarker);
      if (String(state?.url || "").includes("notion.so/chat") && finalOwnership.visibleOutput) {
        artifact.events.push({
          at: new Date().toISOString(),
          state: "owned_chat_recovered_from_visible_output",
          snapshot: { ...state, body: undefined, ...finalOwnership, timeoutMs: CHAT_START_TIMEOUT_MS }
        });
        return { ...state, ownership: finalOwnership };
      }
      const error = new Error(`chat_start_timeout_after_submit: prompt did not transition to an owned Notion chat within ${CHAT_START_TIMEOUT_MS}ms.`);
      error.transport = "submit";
      error.promptLength = String(prompt || "").length;
      error.inputLength = null;
      error.ownership = finalOwnership;
      artifact.events.push({
        at: new Date().toISOString(),
        state: "chat_start_timeout_after_submit",
        snapshot: {
          ...state,
          matchedPrompt: finalOwnership.matchedPrompt,
          markerMatched: finalOwnership.markerMatched,
          userAnchorMatched: finalOwnership.userAnchorMatched,
          schemaAnchorMatched: finalOwnership.schemaAnchorMatched,
          bodyHasThought: finalOwnership.bodyHasThought,
          bodyHasModelFooter: finalOwnership.bodyHasModelFooter,
          candidateLength: finalOwnership.candidateLength,
          ownershipConfidence: finalOwnership.ownershipConfidence,
          timeoutMs: CHAT_START_TIMEOUT_MS
        }
      });
      throw error;
    }
    await dismissOverlays(client, artifact);
    if (Date.now() - lastEventAt >= 30000) {
      artifact.events.push({
        at: new Date().toISOString(),
        state: "chat_start_waiting",
        snapshot: {
          ...state,
          body: undefined,
          matchedPrompt: ownership.matchedPrompt,
          markerMatched: ownership.markerMatched,
          userAnchorMatched: ownership.userAnchorMatched,
          schemaAnchorMatched: ownership.schemaAnchorMatched,
          bodyHasThought: ownership.bodyHasThought,
          bodyHasModelFooter: ownership.bodyHasModelFooter,
          candidateLength: ownership.candidateLength,
          ownershipConfidence: ownership.ownershipConfidence
        }
      });
      await saveArtifact(artifact).catch(() => {});
      lastEventAt = Date.now();
    }
    await delay(500);
  }
}

async function conversationState(client) {
  return evaluate(
    client,
    `(() => {
      const describeButton = (el) => {
        if (!el) {
          return { found: false, visible: false, disabled: false, ariaDisabled: '', enabled: false };
        }
        const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
        const visible = !!rect
          && rect.width > 0
          && rect.height > 0
          && (!style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'));
        const disabled = !!el.disabled;
        const ariaDisabled = (el.getAttribute('aria-disabled') || '').trim();
        const enabled = visible && !disabled && ariaDisabled !== 'true';
        return { found: true, visible, disabled, ariaDisabled, enabled };
      };
      const roots = Array.from(document.querySelectorAll('[data-content-editable-root="true"], [role="group"]'))
        .map((el) => (el.innerText || '').replace(/\\r/g, '').trim())
        .filter((text) => text && !/^(?:Sonnet|Opus|Claude|GPT|Gemini)\\s+/i.test(text))
        .filter(Boolean);
      const buttons = Array.from(document.querySelectorAll('[role="button"], button'));
      const buttonEntries = buttons.map((el) => ({
        aria: (el.getAttribute('aria-label') || '').trim(),
        ...describeButton(el)
      }));
      const pickEnabledOrFirst = (aria) => {
        const matches = buttonEntries.filter((entry) => entry.aria === aria);
        return matches.find((entry) => entry.enabled) || matches[0] || { found: false, visible: false, enabled: false };
      };
      const copy = pickEnabledOrFirst('Copy response');
      const submit = pickEnabledOrFirst('Submit AI message');
      const stop = pickEnabledOrFirst('Stop AI message');
      const body = document.body ? document.body.innerText : '';
      const finishedTextVisible = /Notion AI finished\\.?/i.test(body);
      const bodyAnswer = (() => {
        const chunks = body.split(/\\nThought\\n/);
        if (chunks.length < 2) return '';
        return chunks[chunks.length - 1]
          .split(/\\n(?:Sonnet|Opus|Claude|GPT|Gemini)\\s/i)[0]
          .replace(/\\nNotion AI finished\\.?$/i, '')
          .trim();
      })();
      return {
        title: document.title,
        url: location.href,
        roots,
        body,
        bodyAnswer,
        copyReady: copy.enabled,
        copyButtonVisible: copy.visible,
        copyButtonEnabled: copy.enabled,
        submitReady: submit.enabled,
        submitButtonVisible: submit.visible,
        submitButtonEnabled: submit.enabled,
        stopActive: stop.enabled,
        stopButtonVisible: stop.visible,
        stopButtonEnabled: stop.enabled,
        stopButtonCount: buttonEntries.filter((entry) => entry.aria === 'Stop AI message').length,
        finishedTextVisible
      };
    })()`
  );
}

function cleanText(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

function extractChatId(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.searchParams.get("t") || "";
  } catch (_error) {
    return "";
  }
}

function currentPromptSegment(body, needle) {
  const text = String(body || "");
  const normalizedNeedle = normalizeForMatch(needle);
  if (!normalizedNeedle) {
    return text;
  }
  const lines = text.split(/\n/);
  let best = "";
  for (let index = 0; index < lines.length; index += 1) {
    const tail = lines.slice(index).join("\n");
    if (normalizeForMatch(tail).includes(normalizedNeedle)) {
      best = tail;
    }
  }
  return best;
}

function extractOwnedBodyAnswer(body, needle) {
  const segment = currentPromptSegment(body, needle);
  if (!segment) {
    return "";
  }
  return extractBodyAnswer(segment);
}

function classifyAnswerEvidence(candidate, state, completeJsonArtifact = false) {
  const candidateLength = cleanText(candidate).length;
  const substantiveOutput = candidateLength > 0 || !!completeJsonArtifact;
  const activeGeneration = !!state?.stopActive;
  const terminalUiHint = !!state?.copyReady
    || !!state?.finishedTextVisible
    || !!state?.bodyHasModelFooter;
  return {
    candidateLength,
    substantiveOutput,
    activeGeneration,
    terminalUiHint,
    hasGenerationEvidence: substantiveOutput || activeGeneration
  };
}

function hasAnswerGenerationEvidence(candidate, state, completeJsonArtifact = false) {
  return classifyAnswerEvidence(candidate, state, completeJsonArtifact).hasGenerationEvidence;
}

function shouldFailAnswerNoOutput(hasGenerationEvidence, noOutputMs, timeoutMs) {
  return !hasGenerationEvidence && timeoutMs > 0 && noOutputMs >= timeoutMs;
}

async function reacquireOwnedChat(client, artifact, reason) {
  if (!artifact?.ownedChatUrl || !artifact?.ownedChatId || OWNED_CHAT_REACQUIRE_ATTEMPTS <= 0) {
    return null;
  }
  for (let attempt = 1; attempt <= OWNED_CHAT_REACQUIRE_ATTEMPTS; attempt += 1) {
    artifact.events.push({
      at: new Date().toISOString(),
      state: "owned_chat_reacquire_started",
      snapshot: {
        attempt,
        attempts: OWNED_CHAT_REACQUIRE_ATTEMPTS,
        reason,
        ownedChatId: artifact.ownedChatId,
        ownedChatUrl: artifact.ownedChatUrl
      }
    });
    updateActiveJob(artifact, "owned_chat_reacquire", {
      attempt,
      attempts: OWNED_CHAT_REACQUIRE_ATTEMPTS,
      reason,
      ownedChatId: artifact.ownedChatId,
      url: artifact.ownedChatUrl
    });
    try {
      await client.send("Page.navigate", { url: artifact.ownedChatUrl });
      await delay(1500 * attempt);
      const state = await conversationState(client);
      const chatId = extractChatId(state.url);
      const recovered = chatId === artifact.ownedChatId && String(state.url || "").includes("notion.so/chat");
      artifact.events.push({
        at: new Date().toISOString(),
        state: recovered ? "owned_chat_reacquired" : "owned_chat_reacquire_observed_wrong_target",
        snapshot: {
          attempt,
          url: state.url,
          chatId,
          ownedChatId: artifact.ownedChatId,
          candidateLength: cleanText(state.bodyAnswer || "").length
        }
      });
      if (recovered) {
        return state;
      }
    } catch (error) {
      artifact.events.push({
        at: new Date().toISOString(),
        state: "owned_chat_reacquire_attempt_failed",
        snapshot: {
          attempt,
          error: String(error?.message || error)
        }
      });
    }
  }
  return null;
}

async function waitForAnswer(client, prompt, artifact) {
  const started = Date.now();
  let lastText = "";
  let lastChanged = Date.now();
  let noOutputSince = Date.now();
  let latest = null;
  let lastEventAt = 0;
  const needle = promptNeedle(prompt);

  while (true) {
    await delay(POLL_MS);
    latest = await conversationState(client);
    let latestChatId = extractChatId(latest.url);
    if (artifact.ownedChatId && latestChatId && latestChatId !== artifact.ownedChatId) {
      const recovered = await reacquireOwnedChat(client, artifact, `chat_changed:${latestChatId}`);
      if (!recovered) {
        throw new Error(`owned_chat_reacquire_failed: expected ${artifact.ownedChatId}, saw ${latestChatId}`);
      }
      latest = recovered;
      latestChatId = extractChatId(latest.url);
    }
    if (!String(latest.url || "").includes("notion.so/chat")) {
      const recovered = await reacquireOwnedChat(client, artifact, `left_chat:${latest.url || "unknown url"}`);
      if (!recovered) {
        throw new Error(`owned_chat_reacquire_failed: target left chat page before answer extraction: ${latest.url || "unknown url"}`);
      }
      latest = recovered;
      latestChatId = extractChatId(latest.url);
    }
    const ownership = ownershipSnapshot(latest.body || "", prompt, artifact.requestMarker);
    artifact.ownership = mergeOwnershipEvidence(artifact.ownership, ownership);
    artifact.ownershipLastState = ownership;
    const segmentNeedle = ownership.markerMatched ? normalizeForMatch(artifact.requestMarker) : needle;
    const ownedSegment = currentPromptSegment(latest.body || "", segmentNeedle);
    const matchedPrompt = !!ownedSegment;
    const roots = Array.isArray(latest.roots)
      ? latest.roots.map(cleanText).filter((text) => text && !promptContainsCandidate(prompt, text))
      : [];
    const segmentedAnswer = matchedPrompt ? cleanText(extractOwnedBodyAnswer(latest.body || "", segmentNeedle)) : "";
    const fullBodyAnswer = cleanText(extractBodyAnswer(latest.body || ""));
    const bodyAnswer = segmentedAnswer || fullBodyAnswer;
    const rawCandidate = bodyAnswer || (roots.length ? roots[roots.length - 1] : "");
    const candidate = bodyAnswer || (!promptContainsCandidate(prompt, rawCandidate) ? rawCandidate : "");
    const completeJsonArtifact = looksLikeCompleteJsonArtifact(candidate);
    if (candidate && candidate !== lastText) {
      lastText = candidate;
      lastChanged = Date.now();
    }
    const answerEvidence = classifyAnswerEvidence(candidate, {
      ...latest,
      bodyHasModelFooter: ownership.bodyHasModelFooter
    }, completeJsonArtifact);
    const hasGenerationEvidence = answerEvidence.hasGenerationEvidence;
    if (hasGenerationEvidence) {
      noOutputSince = Date.now();
    }
    artifact.lastState = {
      at: new Date().toISOString(),
      url: latest.url,
      title: latest.title,
      candidateLength: candidate.length,
      rootCount: roots.length,
      copyReady: latest.copyReady,
      copyButtonVisible: latest.copyButtonVisible,
      copyButtonEnabled: latest.copyButtonEnabled,
      submitReady: latest.submitReady,
      submitButtonVisible: latest.submitButtonVisible,
      submitButtonEnabled: latest.submitButtonEnabled,
      stopActive: latest.stopActive,
      stopButtonVisible: latest.stopButtonVisible,
      stopButtonEnabled: latest.stopButtonEnabled,
      stopButtonCount: latest.stopButtonCount,
      finishedTextVisible: latest.finishedTextVisible,
      completeJsonArtifact,
      quietMs: Date.now() - lastChanged,
      matchedPrompt: ownership.matchedPrompt,
      markerMatched: ownership.markerMatched,
      userAnchorMatched: ownership.userAnchorMatched,
      schemaAnchorMatched: ownership.schemaAnchorMatched,
      bodyHasThought: ownership.bodyHasThought,
      bodyHasModelFooter: ownership.bodyHasModelFooter,
      substantiveOutput: answerEvidence.substantiveOutput,
      activeGeneration: answerEvidence.activeGeneration,
      terminalUiHint: answerEvidence.terminalUiHint,
      noOutputMs: Date.now() - noOutputSince,
      ownershipConfidence: artifact.ownership?.ownershipConfidence || ownership.ownershipConfidence,
      currentObservationConfidence: ownership.ownershipConfidence
    };
    updateActiveJob(artifact, "waiting_for_answer", {
      stageAgeMs: Date.now() - started,
      candidateLength: candidate.length,
      quietMs: Date.now() - lastChanged,
      copyReady: latest.copyReady,
      copyButtonVisible: latest.copyButtonVisible,
      copyButtonEnabled: latest.copyButtonEnabled,
      stopActive: latest.stopActive,
      stopButtonVisible: latest.stopButtonVisible,
      stopButtonEnabled: latest.stopButtonEnabled,
      stopButtonCount: latest.stopButtonCount,
      finishedTextVisible: latest.finishedTextVisible,
      completeJsonArtifact,
      matchedPrompt: ownership.matchedPrompt,
      markerMatched: ownership.markerMatched,
      ownershipConfidence: artifact.ownership?.ownershipConfidence || ownership.ownershipConfidence,
      currentObservationConfidence: ownership.ownershipConfidence,
      bodyHasThought: ownership.bodyHasThought,
      bodyHasModelFooter: ownership.bodyHasModelFooter,
      substantiveOutput: answerEvidence.substantiveOutput,
      activeGeneration: answerEvidence.activeGeneration,
      terminalUiHint: answerEvidence.terminalUiHint,
      noOutputMs: Date.now() - noOutputSince,
      url: latest.url,
      title: latest.title
    });

    if (shouldFailAnswerNoOutput(hasGenerationEvidence, Date.now() - noOutputSince, ANSWER_NO_OUTPUT_TIMEOUT_MS)) {
      artifact.events.push({
        at: new Date().toISOString(),
        state: "answer_no_output_timeout",
        snapshot: artifact.lastState
      });
      await saveArtifact(artifact).catch(() => {});
      throw new Error(
        `answer_no_output_timeout_after_submit: owned chat showed no substantive output or active generation for ${ANSWER_NO_OUTPUT_TIMEOUT_MS}ms after submit. Decorative terminal UI hints are not answer evidence.`
      );
    }

    const quietMs = Date.now() - lastChanged;
    const terminalQuietAnswer = candidate
      && answerEvidence.substantiveOutput
      && ownership.bodyHasModelFooter
      && quietMs >= ACTIVE_QUIET_MS;

    if (candidate && (completeJsonArtifact || terminalQuietAnswer || (!latest.stopActive && (latest.copyReady || latest.finishedTextVisible)))) {
      artifact.events.push({ at: new Date().toISOString(), state: "answer_ready_copy", snapshot: artifact.lastState });
      updateActiveJob(artifact, "answer_ready", { candidateLength: candidate.length });
      return candidate;
    }

    const requiredQuietMs = QUIET_MS;
    if (candidate && !latest.stopActive && quietMs >= requiredQuietMs) {
      artifact.events.push({
        at: new Date().toISOString(),
        state: completeJsonArtifact ? "answer_ready_complete_json" : "answer_ready",
        snapshot: artifact.lastState
      });
      updateActiveJob(artifact, "answer_ready", { candidateLength: candidate.length });
      return candidate;
    }
    if (Date.now() - lastEventAt >= 30000) {
      artifact.events.push({ at: new Date().toISOString(), state: "answer_waiting", snapshot: artifact.lastState });
      lastEventAt = Date.now();
      await saveArtifact(artifact).catch(() => {});
    }
  }
}

function extractPromptPayload(parsed) {
  if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
    return parsed.prompt;
  }
  if (typeof parsed.input === "string" && parsed.input.trim()) {
    return parsed.input;
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const system = messages.filter((m) => m?.role === "system" && typeof m.content === "string").map((m) => m.content).filter((content) => content.trim());
  const latestUser = [...messages].reverse().find((m) => m?.role === "user" && typeof m.content === "string" && m.content.trim());
  if (!latestUser) {
    return "";
  }
  const wantsJson = parsed.return_json === true || parsed.format === "json" || !!parsed.response_format || !!parsed.schema;
  const parts = [];
  parts.push(
    [
      "PROVIDER CONTRACT:",
      "This is an API-style generation call for a local code system.",
      "Treat system as durable instruction and user as the task/input payload.",
      "Do not describe Notion, the chat UI, or this bridge unless explicitly asked.",
      "Do not claim verified local state, files, repositories, live facts, tests, or tools unless evidence is supplied in the prompt.",
      "Return the requested artifact directly."
    ].join("\n")
  );
  if (wantsJson) {
    parts.push(
      [
        "STRUCTURED OUTPUT CONTRACT:",
        "Return raw JSON only. No markdown fences, no explanation, no conversational preface.",
        "Produce a structured artifact matching the requested JSON/schema contract.",
        "Use only facts present in the supplied input. Preserve uncertainty instead of fabricating certainty.",
        "If the request only asks you to format supplied values or extract user-provided facts, do that directly."
      ].join("\n")
    );
  }
  if (system.length) {
    parts.push(`system:\n${system.join("\n\n")}`);
  }
  if (latestUser) {
    parts.push(`user:\n${latestUser.content}`);
  }
  if (parsed.response_format || parsed.schema) {
    parts.push(`requested_output_contract:\n${JSON.stringify(parsed.response_format || parsed.schema)}`);
  }
  return parts.join("\n\n");
}

async function saveArtifact(artifact) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const filePath = path.join(ARTIFACT_DIR, `${artifact.requestId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), "utf8");
  lastArtifactPath = filePath;
  return filePath;
}

async function runPrompt(prompt) {
  const requestId = nextRequestId();
  const originalPrompt = String(prompt || "");
  const marker = requestMarker(requestId);
  prompt = addRequestMarkerToPrompt(originalPrompt, marker);
  const artifact = {
    requestId,
    startedAt: new Date().toISOString(),
    originalPrompt,
    requestMarker: marker,
    prompt,
    events: []
  };
  activeJobs.set(artifact.requestId, {
    requestId: artifact.requestId,
    startedAt: artifact.startedAt,
    startedMs: Date.now(),
    phase: "starting",
    updatedAt: artifact.startedAt
  });
  let client = null;
  let targetId = null;
  try {
    const connected = await connectNotionPage(artifact);
    updateActiveJob(artifact, "connected");
    client = connected.client;
    targetId = connected.target?.id || null;
    if (targetId) {
      activeTargetIds.add(targetId);
    }
    artifact.events.push({ at: new Date().toISOString(), state: "connected", snapshot: connected.target });
    if (USE_NATIVE_CTRL_O) {
      await startNativeNewChat(client, artifact);
      if (targetId) {
        activeTargetIds.delete(targetId);
      }
      client.close();
      const nativeAttached = await attachNewestNotionAiTarget(artifact);
      client = nativeAttached.client;
      targetId = nativeAttached.target?.id || null;
      if (targetId) {
        activeTargetIds.add(targetId);
      }
    } else {
      await gotoAiHome(client, artifact);
    }
    await dismissOverlays(client, artifact);
    await waitForComposer(client, artifact);
    await dismissOverlays(client, artifact);
    const pasteState = await pastePrompt(client, prompt, artifact);
    if (!pasteState?.alreadySubmitted) {
      if (pasteState?.needsSubmitFallback) {
        artifact.events.push({
          at: new Date().toISOString(),
          state: "submit_fallback_after_insert",
          snapshot: {
            inputLength: pasteState.inputLength,
            submitReady: pasteState.submitReady,
            submitButtonVisible: pasteState.submitButtonVisible,
            submitButtonEnabled: pasteState.submitButtonEnabled
          }
        });
        updateActiveJob(artifact, "submit_fallback_after_insert", { inputLength: pasteState.inputLength });
      }
      await submit(client, artifact);
      updateActiveJob(artifact, "submitted");
    }
    const chatState = await waitForChatStarted(client, artifact, prompt);
    artifact.ownedTargetId = targetId;
    artifact.ownedChatUrl = chatState.url;
    artifact.ownedChatId = extractChatId(chatState.url);
    artifact.ownership = chatState.ownership || ownershipSnapshot(chatState.body || "", prompt, artifact.requestMarker);
    artifact.events.push({
      at: new Date().toISOString(),
      state: "owned_chat_frozen",
      snapshot: {
        targetId,
        url: artifact.ownedChatUrl,
        chatId: artifact.ownedChatId,
        matchedPrompt: artifact.ownership.matchedPrompt,
        markerMatched: artifact.ownership.markerMatched,
        userAnchorMatched: artifact.ownership.userAnchorMatched,
        schemaAnchorMatched: artifact.ownership.schemaAnchorMatched,
        bodyHasThought: artifact.ownership.bodyHasThought,
        bodyHasModelFooter: artifact.ownership.bodyHasModelFooter,
        candidateLength: artifact.ownership.candidateLength,
        ownershipConfidence: artifact.ownership.ownershipConfidence
      }
    });
    updateActiveJob(artifact, "owned_chat_frozen", {
      targetId,
      url: artifact.ownedChatUrl,
      ownedChatId: artifact.ownedChatId,
      matchedPrompt: artifact.ownership.matchedPrompt,
      markerMatched: artifact.ownership.markerMatched,
      ownershipConfidence: artifact.ownership.ownershipConfidence,
      candidateLength: artifact.ownership.candidateLength,
      bodyHasThought: artifact.ownership.bodyHasThought,
      bodyHasModelFooter: artifact.ownership.bodyHasModelFooter
    });
    const text = await waitForAnswer(client, prompt, artifact);
    artifact.completedAt = new Date().toISOString();
    artifact.output = text;
    const artifactPath = await saveArtifact(artifact);
    lastCompletedAt = artifact.completedAt;
    lastError = null;
    return { text, artifactPath, requestId: artifact.requestId };
  } catch (error) {
    artifact.failedAt = new Date().toISOString();
    artifact.error = String(error?.message || error);
    artifact.transport = error?.transport || null;
    artifact.promptLength = error?.promptLength || (typeof prompt === "string" ? prompt.length : null);
    artifact.inputLength = error?.inputLength || null;
    artifact.transportFailures = error?.failures || null;
    artifact.ownership = error?.ownership || artifact.ownership || null;
    await saveArtifact(artifact).catch(() => {});
    lastError = artifact.error;
    throw error;
  } finally {
    if (client) {
      client.close();
    }
    if (targetId) {
      activeTargetIds.delete(targetId);
    }
    activeJobs.delete(artifact.requestId);
  }
}

function toOpenAi(result) {
  return {
    id: result.requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "notion-clean-bridge",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        finish_reason: "stop"
      }
    ],
    usage: null,
    notion_bridge: {
      provider: "notion-clean",
      artifact_path: result.artifactPath
    }
  };
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      busy: activeRequests >= MAX_CONCURRENT_REQUESTS,
      activeRequests,
      queuedRequests: requestQueue.length,
      activeTargetIds: activeTargetIds.size,
      activeTargetIdList: Array.from(activeTargetIds),
      maxConcurrentRequests: MAX_CONCURRENT_REQUESTS,
      maxQueueDepth: MAX_QUEUE_DEPTH,
      jobTimeoutMs: JOB_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      quietMs: QUIET_MS,
      activeQuietMs: ACTIVE_QUIET_MS,
      cdpCommandTimeoutMs: CDP_COMMAND_TIMEOUT_MS,
      cdpConnectAttempts: CDP_CONNECT_ATTEMPTS,
      insertChunkChars: INSERT_CHUNK_CHARS,
      insertVerifyTimeoutMs: INSERT_VERIFY_TIMEOUT_MS,
      chatStartTimeoutMs: CHAT_START_TIMEOUT_MS,
      answerNoOutputTimeoutMs: ANSWER_NO_OUTPUT_TIMEOUT_MS,
      ownedChatReacquireAttempts: OWNED_CHAT_REACQUIRE_ATTEMPTS,
      clipboardFallbackEnabled: CLIPBOARD_FALLBACK_ENABLED,
      clipboardAttempts: CLIPBOARD_ATTEMPTS,
      useNativeCtrlO: USE_NATIVE_CTRL_O,
      allowStaleRecovery: ALLOW_STALE_RECOVERY,
      transportDegraded,
      lastTransportError,
      lastTransportRecoveryAt,
      quarantinedTargetIds: Array.from(quarantinedTargetIds),
      activeJobs: activeJobSnapshot(),
      queuedJobs: queuedJobSnapshot(),
      port: PORT,
      debugPort: DEBUG_PORT,
      lastCompletedAt,
      lastArtifactPath,
      lastError,
      cleanupIntervalMs: CLEANUP_INTERVAL_MS,
      maxRetainedTabs: MAX_RETAINED_TABS,
      overlayWatchIntervalMs: OVERLAY_WATCH_INTERVAL_MS,
      lastOverlaySweepAt,
      lastOverlayDismissedAt,
      overlaysDismissed,
      lastCleanupAt,
      lastCleanupResult
    });
    return;
  }

  if (req.method === "GET" && String(req.url || "").startsWith("/ready")) {
    const readyUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    const includeComposerProbe = /^(1|true|yes)$/i.test(String(readyUrl.searchParams.get("composer") || ""));
    if (includeComposerProbe) {
      sendJson(res, 400, {
        ok: false,
        error: "ready_composer_probe_removed",
        message: "/ready is read-only. Destructive composer probing is disabled during live provider operation."
      });
      return;
    }
    Promise.all([
      readinessProbe(),
      Promise.resolve(null)
    ])
      .then(([ready, composerProbe]) => sendJson(res, 200, {
        ok: true,
        busy: activeRequests >= MAX_CONCURRENT_REQUESTS,
        activeRequests,
        queuedRequests: requestQueue.length,
        activeTargetIds: activeTargetIds.size,
        activeTargetIdList: Array.from(activeTargetIds),
        maxConcurrentRequests: MAX_CONCURRENT_REQUESTS,
        maxQueueDepth: MAX_QUEUE_DEPTH,
        jobTimeoutMs: JOB_TIMEOUT_MS,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        quietMs: QUIET_MS,
        activeQuietMs: ACTIVE_QUIET_MS,
        cdpCommandTimeoutMs: CDP_COMMAND_TIMEOUT_MS,
        cdpConnectAttempts: CDP_CONNECT_ATTEMPTS,
        insertChunkChars: INSERT_CHUNK_CHARS,
        insertVerifyTimeoutMs: INSERT_VERIFY_TIMEOUT_MS,
        chatStartTimeoutMs: CHAT_START_TIMEOUT_MS,
        answerNoOutputTimeoutMs: ANSWER_NO_OUTPUT_TIMEOUT_MS,
        clipboardFallbackEnabled: CLIPBOARD_FALLBACK_ENABLED,
        clipboardAttempts: CLIPBOARD_ATTEMPTS,
        useNativeCtrlO: USE_NATIVE_CTRL_O,
        allowStaleRecovery: ALLOW_STALE_RECOVERY,
        transportDegraded,
        lastTransportError,
        lastTransportRecoveryAt,
        quarantinedTargetIds: Array.from(quarantinedTargetIds),
        activeJobs: activeJobSnapshot(),
        queuedJobs: queuedJobSnapshot(),
        port: PORT,
        debugPort: DEBUG_PORT,
        targetCount: ready.targetCount,
        cdpProbe: ready.probe,
        composerProbe,
        target: { id: ready.target.id, title: ready.target.title, url: ready.target.url },
        lastCompletedAt,
        lastArtifactPath,
        lastError,
        cleanupIntervalMs: CLEANUP_INTERVAL_MS,
        maxRetainedTabs: MAX_RETAINED_TABS,
        overlayWatchIntervalMs: OVERLAY_WATCH_INTERVAL_MS,
        lastOverlaySweepAt,
        lastOverlayDismissedAt,
        overlaysDismissed,
        lastCleanupAt,
        lastCleanupResult
      }))
      .catch((error) => {
        if (isCdpTransportError(error)) {
          transportDegraded = true;
          lastTransportError = String(error?.message || error);
        }
        sendJson(res, 503, {
          ok: false,
          busy: activeRequests >= MAX_CONCURRENT_REQUESTS,
          activeRequests,
          queuedRequests: requestQueue.length,
          error: error.message,
          transport: error.transport || null,
          promptLength: error.promptLength || null,
          inputLength: error.inputLength || null,
          failures: error.failures || null,
          artifact_path: lastArtifactPath,
          lastArtifactPath,
          lastError,
          transportDegraded,
          lastTransportError,
          lastTransportRecoveryAt
        });
      });
    return;
  }

  if (req.method === "POST" && req.url === "/cleanup") {
    scheduleIdleCleanup()
      .then((result) => sendJson(res, 200, { ok: true, ...result, activeRequests, queuedRequests: requestQueue.length, activeTargetIds: activeTargetIds.size }))
      .catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    req.setTimeout(REQUEST_TIMEOUT_MS > 0 ? REQUEST_TIMEOUT_MS + 10000 : 0);
    readBody(req)
      .then(async (parsed) => {
        const prompt = extractPromptPayload(parsed);
        if (!prompt) {
          sendJson(res, 400, { error: "Missing prompt/messages/input." });
          return;
        }
        const result = await scheduleRequest(() =>
          withTimeout(runPrompt(prompt), JOB_TIMEOUT_MS, "notion_clean_bridge_job_timeout")
        , req);
        sendJson(res, 200, toOpenAi(result));
      })
      .catch((error) => {
        if (isCdpTransportError(error)) {
          transportDegraded = true;
          lastTransportError = String(error?.message || error);
        }
        const status = error.message === "notion_clean_bridge_queue_full" ? 429 : (isCdpTransportError(error) ? 503 : 500);
        sendJson(res, status, {
          error: error.message,
          transport: error.transport || null,
          promptLength: error.promptLength || null,
          inputLength: error.inputLength || null,
          failures: error.failures || null,
          activeRequests,
          queuedRequests: requestQueue.length,
          artifact_path: lastArtifactPath,
          lastArtifactPath,
          transportDegraded,
          lastTransportError,
          lastTransportRecoveryAt
        });
      });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    server.timeout = REQUEST_TIMEOUT_MS > 0 ? REQUEST_TIMEOUT_MS + 10000 : 0;
    server.requestTimeout = REQUEST_TIMEOUT_MS > 0 ? REQUEST_TIMEOUT_MS + 10000 : 0;
    server.headersTimeout = 0;
    log(`Clean Notion bridge listening at http://${HOST}:${PORT}`);
    try {
      launchNotionIfNeeded();
    } catch (error) {
      log("Notion startup failed; watchdog will retry after the next provider readiness request", error.message);
    }
    scheduleIdleCleanup();
    scheduleOverlaySweep();
  });

  setInterval(scheduleIdleCleanup, CLEANUP_INTERVAL_MS).unref();
  setInterval(scheduleOverlaySweep, OVERLAY_WATCH_INTERVAL_MS).unref();
}

function extractBodyAnswer(body) {
  const chunks = String(body || "").split(/\nThought\n/);
  if (chunks.length < 2) return "";
  return cleanText(chunks[chunks.length - 1]
    .split(/\n(?:Sonnet|Opus|Claude|GPT|Gemini)\s/i)[0]
    .replace(/\nNotion AI finished\.?$/i, ""));
}

module.exports = {
  bodyContainsPrompt,
  addRequestMarkerToPrompt,
  chunkPromptText,
  cleanText,
  composerLooksClipped,
  currentPromptSegment,
  extractBodyAnswer,
  extractChatId,
  extractOwnedBodyAnswer,
  extractPromptPayload,
  isCdpTransportError,
  looksLikeCompleteJsonArtifact,
  normalizeForMatch,
  ownershipSnapshot,
  mergeOwnershipEvidence,
  promptAnchors,
  promptCorrelation,
  promptNeedle,
  requestMarker,
  ownershipConfidenceRank,
  classifyAnswerEvidence,
  hasAnswerGenerationEvidence,
  shouldFailAnswerNoOutput,
  shouldAttemptSubmitAfterInsert,
  visibleOutputEvidence,
  visibleEnabledButtonState
};
