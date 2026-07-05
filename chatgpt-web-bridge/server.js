"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const PORT = Number(process.env.CHATGPT_BRIDGE_PORT || 3041);
const HOST = process.env.CHATGPT_BRIDGE_HOST || "127.0.0.1";
const API_TOKEN = process.env.CHATGPT_API_TOKEN || "";
const USER_DATA_DIR = path.resolve(process.env.CHATGPT_USER_DATA_DIR || path.join(__dirname, "profiles", "chatgpt-provider"));
const ARTIFACT_DIR = path.resolve(process.env.CHATGPT_ARTIFACT_DIR || path.join(__dirname, "artifacts"));
const START_URL = process.env.CHATGPT_START_URL || "https://chatgpt.com/";
const HEADLESS = String(process.env.CHATGPT_HEADLESS || "false").toLowerCase() === "true";
const MAX_CONCURRENT = Number(process.env.CHATGPT_MAX_CONCURRENT || 1);
const CHROME_CHANNEL = process.env.CHATGPT_CHROME_CHANNEL || "chrome";
const CHROME_EXE = process.env.CHATGPT_CHROME_EXE || "";
const DEBUG_PORT = Number(process.env.CHATGPT_DEBUG_PORT || 9444);
const MODEL_LABEL = process.env.CHATGPT_MODEL_LABEL || "";
const STABLE_QUIET_MS = Number(process.env.CHATGPT_STABLE_QUIET_MS || 6000);
const STABLE_POLL_MS = Number(process.env.CHATGPT_STABLE_POLL_MS || 750);
const MECHANICAL_TIMEOUT_MS = Number(process.env.CHATGPT_MECHANICAL_TIMEOUT_MS || 120000);
const VIEWPORT_WIDTH = Number(process.env.CHATGPT_VIEWPORT_WIDTH || 1366);
const VIEWPORT_HEIGHT = Number(process.env.CHATGPT_VIEWPORT_HEIGHT || 900);
const BRING_TO_FRONT = String(process.env.CHATGPT_BRING_TO_FRONT || "false").toLowerCase() === "true";

let browser = null;
let browserProcess = null;
let context = null;
let activeJobs = new Map();
let queue = [];
let seq = 0;
let lastCompletedAt = null;
let lastError = null;
let lastArtifactPath = null;
let transportDegraded = false;

function nowIso() {
  return new Date().toISOString();
}

function requestId() {
  seq += 1;
  return `${nowIso().replace(/[:.]/g, "-")}-${String(seq).padStart(4, "0")}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function artifactPathFor(id) {
  ensureDir(ARTIFACT_DIR);
  return path.join(ARTIFACT_DIR, `${id}.json`);
}

function writeArtifact(artifact) {
  const file = artifact.path || artifactPathFor(artifact.requestId);
  artifact.path = file;
  artifact.updatedAt = nowIso();
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2), "utf8");
  lastArtifactPath = file;
  return file;
}

function addEvent(artifact, type, data = {}) {
  artifact.events.push({ at: nowIso(), type, ...data });
  writeArtifact(artifact);
}

function sanitizeMessageContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      if (part && typeof part.content === "string") return part.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return String(content);
}

function buildPrompt(payload, id) {
  if (typeof payload.prompt === "string") {
    return `BRIDGE_REQUEST_ID: ${id}\n\n${payload.prompt}`;
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const sections = [`BRIDGE_REQUEST_ID: ${id}`];

  for (const message of messages) {
    const role = message && message.role ? String(message.role) : "user";
    const content = sanitizeMessageContent(message && message.content);
    if (!content) continue;
    sections.push(`${role}:\n${content}`);
  }

  if (payload.response_format) {
    sections.push(`response_format:\n${JSON.stringify(payload.response_format)}`);
    sections.push("Return only the requested structured output when a structured response is requested.");
  }

  return sections.join("\n\n").trim();
}

function normalizeForAnchor(text) {
  return String(text || "")
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function promptAnchors(prompt, id) {
  const normalized = normalizeForAnchor(prompt);
  const anchors = [`BRIDGE_REQUEST_ID: ${id}`];
  const userMatch = normalized.match(/user:\s*(.{12,200})/i);
  if (userMatch) anchors.push(userMatch[1].trim());
  return anchors;
}

function openAiResponse(content, payload) {
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: payload.model || "chatgpt-web",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ],
    usage: null
  };
}

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function initBrowser() {
  if (context) return context;
  ensureDir(USER_DATA_DIR);

  if (!HEADLESS) {
    const chromePath = resolveChromePath();
    const debugUrl = `http://127.0.0.1:${DEBUG_PORT}`;
    if (!(await canReachCdp(debugUrl))) {
      browserProcess = spawn(chromePath, [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${USER_DATA_DIR}`,
        "--profile-directory=Default",
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        START_URL
      ], {
        detached: false,
        stdio: "ignore",
        windowsHide: false
      });
      await waitForCdp(debugUrl, MECHANICAL_TIMEOUT_MS);
    }
    browser = await chromium.connectOverCDP(debugUrl);
    context = browser.contexts()[0] || await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      locale: process.env.CHATGPT_LOCALE || "en-US",
      timezoneId: process.env.CHATGPT_TIMEZONE || "Asia/Katmandu"
    });
    return context;
  }

  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: CHROME_CHANNEL,
    headless: true,
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    locale: process.env.CHATGPT_LOCALE || "en-US",
    timezoneId: process.env.CHATGPT_TIMEZONE || "Asia/Katmandu",
    args: ["--no-first-run", "--no-default-browser-check"]
  });
  return context;
}

function resolveChromePath() {
  const candidates = [
    CHROME_EXE,
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LocalAppData || "", "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("chrome_executable_not_found");
  return found;
}

async function canReachCdp(debugUrl) {
  try {
    const res = await fetch(`${debugUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(debugUrl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canReachCdp(debugUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`chrome_cdp_not_ready_after_${timeoutMs}ms`);
}

async function getPage() {
  const ctx = await initBrowser();
  let page = ctx.pages().find((p) => {
    const url = p.url();
    return url.includes("chatgpt.com") || url.includes("chat.openai.com");
  });
  if (!page) page = await ctx.newPage();
  if (!/chatgpt\.com|chat\.openai\.com/.test(page.url())) {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: MECHANICAL_TIMEOUT_MS });
  }
  if (BRING_TO_FRONT) await page.bringToFront();
  return page;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : "";
    const locationHref = location.href;
    const title = document.title;
    const composer = findComposerNode();
    const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
    const stopButton = findButtonByTextOrLabel(/stop/i);
    const sendButton = findButtonByTextOrLabel(/send|submit/i);
    const newChat = findButtonByTextOrLabel(/new chat/i) || document.querySelector('a[href="/"]');
    return {
      url: locationHref,
      title,
      bodyLength: bodyText.length,
      bodyPreview: bodyText.slice(0, 2000),
      hasComposer: Boolean(composer),
      composerText: getNodeText(composer),
      assistantCount,
      userCount,
      stopActive: Boolean(stopButton && !stopButton.disabled),
      sendReady: Boolean(sendButton && !sendButton.disabled),
      hasNewChat: Boolean(newChat)
    };

    function getNodeText(node) {
      if (!node) return "";
      if ("value" in node) return node.value || "";
      return node.innerText || node.textContent || "";
    }

    function findComposerNode() {
      const selectors = [
        "#prompt-textarea",
        'textarea[data-testid="prompt-textarea"]',
        'div[contenteditable="true"][id="prompt-textarea"]',
        'div[contenteditable="true"]',
        "textarea"
      ];
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) return node;
      }
      return null;
    }

    function findButtonByTextOrLabel(pattern) {
      const nodes = [...document.querySelectorAll("button,a")];
      return nodes.find((node) => {
        const text = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-testid") || ""} ${node.innerText || ""}`;
        return pattern.test(text);
      }) || null;
    }
  });
}

async function findComposer(page) {
  const locators = [
    page.locator("#prompt-textarea").first(),
    page.locator('textarea[data-testid="prompt-textarea"]').first(),
    page.locator('div[contenteditable="true"][id="prompt-textarea"]').first(),
    page.locator('div[contenteditable="true"]').first(),
    page.locator("textarea").first()
  ];
  for (const locator of locators) {
    try {
      if (await locator.count() && await locator.isVisible({ timeout: 1000 })) return locator;
    } catch {
      // Try the next known composer shape.
    }
  }
  throw new Error("chatgpt_composer_not_found");
}

async function openFreshChat(page, artifact) {
  addEvent(artifact, "fresh_chat_started", { url: page.url() });
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: MECHANICAL_TIMEOUT_MS });
  await page.waitForLoadState("domcontentloaded", { timeout: MECHANICAL_TIMEOUT_MS }).catch(() => {});

  const candidates = [
    page.getByRole("link", { name: /new chat/i }).first(),
    page.getByRole("button", { name: /new chat/i }).first(),
    page.locator('a[href="/"]').first()
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.count() && await candidate.isVisible({ timeout: 1500 })) {
        await candidate.click({ timeout: 5000 });
        await page.waitForTimeout(1000);
        addEvent(artifact, "fresh_chat_clicked", { url: page.url() });
        break;
      }
    } catch {
      // It is fine if the current landing page is already a fresh composer.
    }
  }

  await withTimeout(findComposer(page), MECHANICAL_TIMEOUT_MS, "fresh chat composer wait");
  addEvent(artifact, "fresh_chat_ready", await snapshot(page));
}

async function clearComposer(page, composer, artifact) {
  addEvent(artifact, "composer_clear_started");
  try {
    await composer.fill("", { timeout: MECHANICAL_TIMEOUT_MS });
  } catch {
    await composer.click({ timeout: MECHANICAL_TIMEOUT_MS });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
  }
  await page.waitForTimeout(200);
  const snap = await snapshot(page);
  if (snap.composerText && snap.composerText.trim()) {
    await page.evaluate(() => {
      const node = document.querySelector("#prompt-textarea") || document.querySelector('textarea[data-testid="prompt-textarea"]') || document.querySelector('div[contenteditable="true"]') || document.querySelector("textarea");
      if (!node) return false;
      if ("value" in node) node.value = "";
      else node.textContent = "";
      node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      return true;
    });
  }
  addEvent(artifact, "composer_clear_finished", await snapshot(page));
}

async function verifyInsertedPrompt(page, prompt, artifact, verificationLabel) {
  const snap = await snapshot(page);
  artifact.observedComposerLength = snap.composerText.length;
  artifact.observedComposerPreview = snap.composerText.slice(0, 1000);
  writeArtifact(artifact);
  const observed = normalizeForAnchor(snap.composerText);
  const missingAnchors = promptAnchors(prompt, artifact.requestId).filter((anchor) => !observed.includes(normalizeForAnchor(anchor)));
  if (missingAnchors.length) {
    return {
      ok: false,
      observedLength: snap.composerText.length,
      missingAnchors
    };
  }
  addEvent(artifact, "prompt_insert_verified", {
    observedComposerLength: snap.composerText.length,
    verification: verificationLabel
  });
  return { ok: true, observedLength: snap.composerText.length, missingAnchors: [] };
}

async function insertPrompt(page, prompt, artifact) {
  artifact.phase = "inserting_prompt";
  artifact.inputLength = prompt.length;
  writeArtifact(artifact);
  addEvent(artifact, "prompt_insert_started", { inputLength: prompt.length });

  const composer = await withTimeout(findComposer(page), MECHANICAL_TIMEOUT_MS, "composer acquisition");
  await clearComposer(page, composer, artifact);

  try {
    artifact.transport = "playwright_locator_fill";
    artifact.insertedChars = prompt.length;
    writeArtifact(artifact);
    await composer.fill(prompt, { timeout: MECHANICAL_TIMEOUT_MS });
    const fillResult = await verifyInsertedPrompt(page, prompt, artifact, "marker_and_user_anchor_locator_fill");
    if (fillResult.ok) return;
    addEvent(artifact, "prompt_insert_fill_unverified", fillResult);
  } catch (error) {
    addEvent(artifact, "prompt_insert_fill_failed", { error: error.message });
  }

  await clearComposer(page, composer, artifact);
  await composer.click({ timeout: MECHANICAL_TIMEOUT_MS });

  const chunkSize = 8000;
  let inserted = 0;
  for (let i = 0; i < prompt.length; i += chunkSize) {
    const chunk = prompt.slice(i, i + chunkSize);
    await page.keyboard.insertText(chunk);
    inserted += chunk.length;
    artifact.insertedChars = inserted;
    artifact.transport = "playwright_keyboard_insert_text";
    if (inserted === prompt.length || inserted % 40000 < chunkSize) {
      addEvent(artifact, "prompt_insert_chunk", { insertedChars: inserted, inputLength: prompt.length });
    } else {
      writeArtifact(artifact);
    }
  }

  const keyboardResult = await verifyInsertedPrompt(page, prompt, artifact, "marker_and_user_anchor_keyboard_insert");
  if (!keyboardResult.ok) {
    throw new Error(`prompt_insert_verification_failed: observed ${keyboardResult.observedLength} chars after inserting ${prompt.length}; missing anchors: ${keyboardResult.missingAnchors.join(" | ")}`);
  }
}

async function submitPrompt(page, artifact) {
  artifact.phase = "submitting";
  writeArtifact(artifact);
  addEvent(artifact, "submit_started", await snapshot(page));

  const sendCandidates = [
    page.locator('[data-testid="send-button"]').first(),
    page.getByRole("button", { name: /send/i }).first(),
    page.locator('button:has(svg)').last()
  ];
  for (const candidate of sendCandidates) {
    try {
      if (await candidate.count() && await candidate.isVisible({ timeout: 1000 }) && await candidate.isEnabled({ timeout: 1000 })) {
        await candidate.click({ timeout: 5000 });
        addEvent(artifact, "submit_clicked", await snapshot(page));
        return;
      }
    } catch {
      // Fallback below.
    }
  }

  await page.keyboard.press("Enter");
  addEvent(artifact, "submit_enter_pressed", await snapshot(page));
}

async function getAssistantTexts(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    if (nodes.length) {
      return nodes.map((node) => (node.innerText || node.textContent || "").trim()).filter(Boolean);
    }
    const articles = [...document.querySelectorAll("article")];
    return articles.map((node) => (node.innerText || node.textContent || "").trim()).filter(Boolean);
  });
}

function cleanAssistantText(text) {
  return String(text || "")
    .replace(/\n?ChatGPT can make mistakes\.[\s\S]*$/i, "")
    .replace(/\n?(Copy|Good response|Bad response|Share)$/gim, "")
    .trim();
}

async function waitForAnswer(page, beforeCount, artifact) {
  artifact.phase = "waiting_for_answer";
  writeArtifact(artifact);
  addEvent(artifact, "answer_wait_started", { beforeCount });

  let lastText = "";
  let lastChanged = Date.now();
  let seenAny = false;

  while (true) {
    const texts = await getAssistantTexts(page);
    const candidate = cleanAssistantText(texts.slice(beforeCount).join("\n\n") || texts[texts.length - 1] || "");
    const snap = await snapshot(page);

    artifact.candidateLength = candidate.length;
    artifact.stopActive = snap.stopActive;
    artifact.assistantCount = snap.assistantCount;
    artifact.url = snap.url;
    artifact.title = snap.title;

    if (candidate && candidate !== lastText) {
      lastText = candidate;
      lastChanged = Date.now();
      seenAny = true;
      addEvent(artifact, "answer_candidate_changed", { candidateLength: candidate.length, stopActive: snap.stopActive });
    } else {
      writeArtifact(artifact);
    }

    const quietMs = Date.now() - lastChanged;
    const composerReady = snap.hasComposer && !snap.stopActive;
    if (seenAny && candidate && quietMs >= STABLE_QUIET_MS && composerReady) {
      addEvent(artifact, "answer_stable", { candidateLength: candidate.length, quietMs });
      return candidate;
    }

    await page.waitForTimeout(STABLE_POLL_MS);
  }
}

async function executeRequest(payload, artifact) {
  const prompt = buildPrompt(payload, artifact.requestId);
  artifact.promptPreview = prompt.slice(0, 2000);
  artifact.inputLength = prompt.length;
  writeArtifact(artifact);

  const page = await getPage();
  addEvent(artifact, "page_acquired", await snapshot(page));

  await openFreshChat(page, artifact);
  const beforeTexts = await getAssistantTexts(page);
  artifact.beforeAssistantCount = beforeTexts.length;
  writeArtifact(artifact);

  await insertPrompt(page, prompt, artifact);
  await submitPrompt(page, artifact);
  const answer = await waitForAnswer(page, beforeTexts.length, artifact);

  artifact.phase = "completed";
  artifact.outputLength = answer.length;
  artifact.outputPreview = answer.slice(0, 2000);
  addEvent(artifact, "request_completed", { outputLength: answer.length });
  lastCompletedAt = nowIso();
  transportDegraded = false;
  return openAiResponse(answer, payload);
}

function enqueue(job) {
  queue.push(job);
  pumpQueue();
}

function pumpQueue() {
  while (activeJobs.size < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    runJob(job);
  }
}

async function runJob(job) {
  activeJobs.set(job.artifact.requestId, job.artifact);
  job.artifact.phase = "queued_to_active";
  writeArtifact(job.artifact);
  try {
    const result = await executeRequest(job.payload, job.artifact);
    sendJson(job.res, 200, result);
  } catch (error) {
    lastError = error.message;
    transportDegraded = true;
    job.artifact.phase = "failed";
    job.artifact.error = error.message;
    addEvent(job.artifact, "request_failed", { error: error.message, stack: error.stack });
    sendJson(job.res, 500, {
      error: "chatgpt_web_bridge_failed",
      message: error.message,
      artifact_path: job.artifact.path
    });
  } finally {
    activeJobs.delete(job.artifact.requestId);
    pumpQueue();
  }
}

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function isAuthorized(req) {
  if (!API_TOKEN) return true;
  const header = req.headers.authorization || "";
  return header === `Bearer ${API_TOKEN}`;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 100 * 1024 * 1024) reject(new Error("request_body_too_large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function healthPayload() {
  const jobs = [...activeJobs.values()].map((artifact) => ({
    requestId: artifact.requestId,
    phase: artifact.phase,
    inputLength: artifact.inputLength || 0,
    insertedChars: artifact.insertedChars || 0,
    candidateLength: artifact.candidateLength || 0,
    transport: artifact.transport || null,
    url: artifact.url || null,
    ageMs: Date.now() - artifact.startedMs
  }));
  return {
    ok: true,
    provider: "chatgpt_web_bridge",
    port: PORT,
    host: HOST,
    authRequired: Boolean(API_TOKEN),
    busy: activeJobs.size > 0,
    activeRequests: activeJobs.size,
    queuedRequests: queue.length,
    maxConcurrentRequests: MAX_CONCURRENT,
    transportDegraded,
    lastCompletedAt,
    lastError,
    lastArtifactPath,
    activeJobs: jobs,
    userDataDir: USER_DATA_DIR,
    artifactDir: ARTIFACT_DIR,
    startUrl: START_URL,
    headless: HEADLESS,
    modelLabel: MODEL_LABEL || null
    ,
    debugPort: HEADLESS ? null : DEBUG_PORT,
    launchMode: HEADLESS ? "playwright_headless" : "normal_chrome_cdp_attach",
    bringToFront: BRING_TO_FRONT
  };
}

async function readyPayload() {
  const page = await getPage();
  const snap = await snapshot(page);
  const loginVisible = /\bLog in\b|Sign up for free/i.test(snap.bodyPreview);
  return {
    ok: snap.hasComposer && !loginVisible,
    provider: "chatgpt_web_bridge",
    signedInLikely: snap.hasComposer && !loginVisible,
    loginVisible,
    snapshot: snap
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, healthPayload());
    }

    if (req.method === "GET" && req.url === "/ready") {
      const ready = await withTimeout(readyPayload(), MECHANICAL_TIMEOUT_MS, "ready probe");
      return sendJson(res, ready.ok ? 200 : 503, ready);
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const id = requestId();
      const artifact = {
        requestId: id,
        path: artifactPathFor(id),
        startedAt: nowIso(),
        startedMs: Date.now(),
        phase: "queued",
        events: []
      };
      writeArtifact(artifact);
      req.on("close", () => {
        if (!res.writableEnded) addEvent(artifact, "client_connection_closed");
      });
      enqueue({ payload, artifact, res });
      return;
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    lastError = error.message;
    transportDegraded = true;
    return sendJson(res, 500, { error: "chatgpt_web_bridge_error", message: error.message });
  }
});

if (require.main === module) {
  initBrowser()
    .then(() => {
      server.listen(PORT, HOST, () => {
        console.log(`[chatgpt-web-bridge] listening on http://${HOST}:${PORT}`);
        console.log(`[chatgpt-web-bridge] profile: ${USER_DATA_DIR}`);
      });
    })
    .catch((error) => {
      console.error("[chatgpt-web-bridge] fatal startup error", error);
      process.exit(1);
    });
}

module.exports = {
  buildPrompt,
  cleanAssistantText,
  openAiResponse,
  healthPayload
  ,
  normalizeForAnchor,
  promptAnchors
};
