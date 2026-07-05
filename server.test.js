"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  addRequestMarkerToPrompt,
  bodyContainsPrompt,
  chunkPromptText,
  cleanText,
  composerLooksClipped,
  currentPromptSegment,
  extractBodyAnswer,
  extractChatId,
  extractOwnedBodyAnswer,
  extractPromptPayload,
  classifyAnswerEvidence,
  hasAnswerGenerationEvidence,
  isCdpTransportError,
  looksLikeCompleteJsonArtifact,
  mergeOwnershipEvidence,
  normalizeForMatch,
  ownershipSnapshot,
  promptCorrelation,
  promptNeedle,
  requestMarker,
  shouldFailAnswerNoOutput,
  shouldAttemptSubmitAfterInsert,
  visibleOutputEvidence,
  visibleEnabledButtonState
} = require("./server");

test("prompt correlation uses only the user role payload", () => {
  const prompt = [
    "system:",
    "Return raw JSON only.",
    "",
    "user:",
    "Return exactly {\"handoff_probe\":\"ok\"}",
    "",
    "requested_output_contract:",
    "{\"type\":\"json_object\"}"
  ].join("\n");
  const notionBody = "user: Return exactly {\"handoff_probe\":\"ok\"} Thought {\"handoff_probe\":\"ok\"}";

  assert.equal(promptNeedle(prompt), normalizeForMatch("Return exactly {\"handoff_probe\":\"ok\"}"));
  assert.equal(bodyContainsPrompt(notionBody, promptNeedle(prompt)), true);
});

test("long user payload correlation uses a bounded stable witness", () => {
  const longUser = "long-payload-" + "x".repeat(50000);
  const prompt = `system:\nPreserve content.\n\nuser:\n${longUser}\n\nrequested_output_contract:\n{"type":"json_object"}`;

  assert.equal(promptNeedle(prompt), normalizeForMatch(longUser).slice(0, 512));
  assert.equal(bodyContainsPrompt(`prefix ${longUser} suffix`, promptNeedle(prompt)), true);
});

test("markdown source and rendered visible text match semantically", () => {
  const source = [
    "## Evidence Court",
    "",
    "**Core Doctrine**",
    "",
    "- `BuildRecoveryContext` is primary.",
    "- Do not infer app modules.",
    "",
    "1. **Reported evidence**",
    "   - what the buyer said happened",
    "",
    "---",
    "",
    "> Preserve uncertainty.",
    "",
    "[Docs](https://example.com)"
  ].join("\n");
  const rendered = [
    "Evidence Court",
    "Core Doctrine",
    "BuildRecoveryContext is primary.",
    "Do not infer app modules.",
    "Reported evidence",
    "what the buyer said happened",
    "Preserve uncertainty.",
    "Docs"
  ].join("\n");

  assert.equal(normalizeForMatch(source), normalizeForMatch(rendered));
});

test("prompt body detection is markdown presentation agnostic", () => {
  const prompt = [
    "system:",
    "Return JSON.",
    "",
    "user:",
    "# Build Recovery Evidence Register",
    "",
    "- `BuildRecoveryContext` is primary.",
    "- **Reported evidence** stays reported.",
    "",
    "requested_output_contract:",
    "{\"type\":\"json_object\"}"
  ].join("\n");
  const renderedBody = [
    "Build Recovery Evidence Register",
    "BuildRecoveryContext is primary.",
    "Reported evidence stays reported.",
    "Thought",
    "{\"intake_boundary\":\"ok\"}"
  ].join("\n");

  assert.equal(bodyContainsPrompt(renderedBody, promptNeedle(prompt)), true);
});

test("prompt body detection survives Notion flattening list blocks inline", () => {
  const prompt = [
    "system:",
    "Return JSON.",
    "",
    "user:",
    "You are ReArch's architecture synthesis cell.",
    "Your job is to produce the architecture candidate that will be stress-reviewed.",
    "",
    "Inputs include:",
    "- the original `ArchitectureCandidate`",
    "- the `ArchitectureDeliverableGapMap`",
    "- zero or more `ArchitectureDeepeningPass` objects",
    "- locked upstream authority",
    "",
    "Synthesis rules:",
    "- preserve the locked case mode and intended app",
    "- merge useful deepening material into one coherent candidate",
    "",
    "requested_output_contract:",
    "{\"type\":\"json_object\"}"
  ].join("\n");
  const renderedBody = [
    "You are ReArch's architecture synthesis cell.",
    "Your job is to produce the architecture candidate that will be stress-reviewed.",
    "Inputs include:- the original ArchitectureCandidate- the ArchitectureDeliverableGapMap- zero or more ArchitectureDeepeningPass objects- locked upstream authority",
    "Synthesis rules:- preserve the locked case mode and intended app- merge useful deepening material into one coherent candidate"
  ].join("\n");

  assert.equal(bodyContainsPrompt(renderedBody, promptNeedle(prompt)), true);
});

test("prompt body detection survives flattened fenced text marker without losing first content word", () => {
  const prompt = [
    "system:",
    "Return JSON.",
    "",
    "user:",
    "# Execution Stress Review - Builder Usability Prosecutor",
    "Question to answer:",
    "```text",
    "Would a real builder know exactly what to do, what not to do, how to preserve architecture, and when to stop?",
    "```",
    "",
    "## Inputs",
    "Use the ExecutionCandidatePlan and final FullAppRecoveryArchitecture."
  ].join("\n");
  const renderedBody = [
    "REARCH",
    "API generation call instructions",
    "system: Return JSON.",
    "user: # Execution Stress Review - Builder Usability Prosecutor",
    "Question to answer:",
    "```textWould a real builder know exactly what to do, what not to do, how to preserve architecture, and when to stop?```",
    "## Inputs",
    "Use the ExecutionCandidatePlan and final FullAppRecoveryArchitecture."
  ].join("\n");

  assert.equal(bodyContainsPrompt(renderedBody, promptNeedle(prompt)), true);
});

test("response cleanup preserves internal whitespace and indentation", () => {
  const response = "  first line\r\n\r\n    indented line\r\nlast line  ";

  assert.equal(cleanText(response), "first line\n\n    indented line\nlast line");
});

test("direct prompt content is preserved and unrelated large bodies are rejected", () => {
  const prompt = "  preserve leading and trailing whitespace  \n";

  assert.equal(extractPromptPayload({ prompt }), prompt);
  assert.equal(extractPromptPayload({ padding: "x".repeat(2 * 1024 * 1024) }), "");
});

test("post-thought answer extraction accepts exact requested literals", () => {
  const body = [
    'user: Return exactly {"queue_fix_probe":"ok"}',
    "Thought",
    '{"queue_fix_probe":"ok"}',
    "Opus 4.8",
    "Notion AI finished."
  ].join("\n");

  assert.equal(extractBodyAnswer(body), '{"queue_fix_probe":"ok"}');
});

test("post-thought answer extraction strips Gemini model footer", () => {
  const body = [
    'user: Return exactly {"default_no_clipboard":"ok"}',
    "Thought",
    '{',
    '"default_no_clipboard": "ok"',
    '}',
    "Gemini 3.1 Pro",
    "Notion AI finished."
  ].join("\n");

  assert.equal(extractBodyAnswer(body), '{\n"default_no_clipboard": "ok"\n}');
});

test("owned extraction ignores stale answer before current prompt", () => {
  const prompt = [
    "system:",
    "Return raw JSON only.",
    "",
    "user:",
    "Return exactly {\"owned_probe\":\"ok\"}",
    "",
    "requested_output_contract:",
    "{\"type\":\"json_object\"}"
  ].join("\n");
  const body = [
    "Old request",
    "Thought",
    "{\"stale\":\"bad\"}",
    "Opus 4.8",
    "Notion AI finished.",
    "PROVIDER CONTRACT:",
    "system:",
    "Return raw JSON only.",
    "user:",
    "Return exactly {\"owned_probe\":\"ok\"}",
    "requested_output_contract:",
    "{\"type\":\"json_object\"}",
    "Thought",
    "{\"owned_probe\":\"ok\"}",
    "Opus 4.8",
    "Notion AI finished."
  ].join("\n");

  assert.equal(extractOwnedBodyAnswer(body, promptNeedle(prompt)), '{"owned_probe":"ok"}');
});

test("owned prompt segment starts at current prompt suffix", () => {
  const needle = normalizeForMatch("Return exactly {\"suffix_probe\":\"ok\"}");
  const body = [
    "Old request",
    "Thought",
    "{\"stale\":\"bad\"}",
    "user:",
    "Return exactly {\"suffix_probe\":\"ok\"}",
    "Thought",
    "{\"suffix_probe\":\"ok\"}"
  ].join("\n");

  const segment = currentPromptSegment(body, needle);
  assert.equal(segment.includes("{\"stale\":\"bad\"}"), false);
  assert.equal(segment.includes("{\"suffix_probe\":\"ok\"}"), true);
});

test("request marker gives durable correlation independent of long prompt rendering", () => {
  const marker = requestMarker("2026-07-01T14-06-21-513Z-0026");
  const prompt = addRequestMarkerToPrompt(
    "system:\nReturn JSON.\n\nuser:\n# Architecture Constructor - Native Architecture Candidate\n## Who you are\nYou are the ReArch Architecture Constructor.",
    marker
  );
  const body = [
    "user:# Architecture Constructor - Native Architecture Candidate",
    marker,
    "## Who you areYou are the ReArch Architecture Constructor.",
    "Thought",
    "{\"architecture_thesis\":\"ok\"}",
    "Gemini 3.1 Pro"
  ].join("\n");

  const correlation = promptCorrelation(body, prompt, marker);
  assert.equal(correlation.markerMatched, true);
});

test("collapsed render can fail full prompt match but ownership still recovers from visible output", () => {
  const marker = "";
  const prompt = [
    "system:",
    "Return JSON.",
    "",
    "user:",
    "# Architecture Constructor - Native Architecture Candidate",
    "## Who you are",
    "You are the ReArch Architecture Constructor - a principal recovery architect who has rebuilt hundreds of drifted apps.",
    "",
    "requested_output_contract:",
    "{\"type\":\"object\"}"
  ].join("\n");
  const body = [
    "user:# Architecture Constructor - Native Architecture Candidate",
    "## Who you areYou are the ReArch Architecture Constructor - a principal recovery architect who has rebuilt hundreds of drifted apps.",
    "Thought",
    "{\"architecture_thesis\":\"A single authoritative control system\"}",
    "Gemini 3.1 Pro"
  ].join("\n");

  assert.equal(bodyContainsPrompt(body, promptNeedle(prompt)), false);
  const ownership = ownershipSnapshot(body, prompt, marker);
  assert.equal(ownership.bodyHasThought, true);
  assert.equal(ownership.bodyHasModelFooter, true);
  assert.equal(ownership.candidateLength > 0, true);
  assert.notEqual(ownership.ownershipConfidence, "none");
});

test("visible output evidence extracts candidate even when prompt segment is unavailable", () => {
  const body = [
    "Some rendered prompt with collapsed spacing",
    "Thought",
    "{",
    "\"architecture_thesis\": \"ok\"",
    "}",
    "Gemini 3.1 Pro"
  ].join("\n");

  const evidence = visibleOutputEvidence(body);
  assert.equal(evidence.bodyHasThought, true);
  assert.equal(evidence.bodyHasModelFooter, true);
  assert.equal(evidence.candidate, '{\n"architecture_thesis": "ok"\n}');
  assert.equal(evidence.completeJsonArtifact, true);
});

test("ownership evidence keeps later stronger marker confirmation", () => {
  const weak = { ownershipConfidence: "weak", markerMatched: false };
  const strong = { ownershipConfidence: "strong", markerMatched: true };

  assert.equal(mergeOwnershipEvidence(weak, strong), strong);
  assert.equal(mergeOwnershipEvidence(strong, weak), strong);
});

test("chat id extraction freezes Notion chat identity", () => {
  assert.equal(
    extractChatId("https://www.notion.so/chat?t=38abc&spaceId=space&wfv=chat"),
    "38abc"
  );
  assert.equal(extractChatId("not a url"), "");
});

test("CDP bootstrap failures are classified as transport errors", () => {
  assert.equal(isCdpTransportError(new Error("CDP timeout on Page.enable")), true);
  assert.equal(isCdpTransportError(new Error("CDP timeout on Runtime.evaluate")), true);
  assert.equal(isCdpTransportError(new Error("CDP websocket closed.")), true);
  assert.equal(isCdpTransportError(new Error("schema validation failed")), false);
});

test("prompt chunking preserves exact order and length", () => {
  const source = "abcdefghi";
  const chunks = chunkPromptText(source, 4);

  assert.deepEqual(chunks, ["abcd", "efgh", "i"]);
  assert.equal(chunks.join(""), source);
});

test("transport insertion failures are classified separately from schema failures", () => {
  assert.equal(isCdpTransportError(new Error("Set-Clipboard : Requested Clipboard operation did not succeed.")), true);
  assert.equal(isCdpTransportError(new Error("Input.insertText failed")), true);
  assert.equal(isCdpTransportError(new Error("composer_clear_failed: 12 characters remain")), true);
  assert.equal(isCdpTransportError(new Error("composer_insert_mismatch: no prompt text observed after cdp_insert_text insertion.")), true);
  assert.equal(isCdpTransportError(new Error("composer_submit_not_ready_after_insert: composer stayed disabled")), true);
  assert.equal(isCdpTransportError(new Error("chat_start_timeout_after_submit: prompt did not transition")), true);
  assert.equal(isCdpTransportError(new Error("answer_no_output_timeout_after_submit: no generation evidence")), true);
});

test("empty owned chat fails its finite no-output phase without bounding real generation", () => {
  assert.equal(hasAnswerGenerationEvidence("", { stopActive: false, copyReady: false, finishedTextVisible: false }), false);
  assert.equal(hasAnswerGenerationEvidence("", {
    stopActive: false,
    copyReady: false,
    finishedTextVisible: true,
    bodyHasModelFooter: true
  }), false);
  assert.equal(hasAnswerGenerationEvidence("", { stopActive: false, copyReady: true }), false);
  assert.equal(hasAnswerGenerationEvidence("", { stopActive: true }), true);
  assert.equal(shouldFailAnswerNoOutput(false, 180000, 180000), true);
  assert.equal(shouldFailAnswerNoOutput(false, 179999, 180000), false);
  assert.equal(shouldFailAnswerNoOutput(true, 900000, 180000), false);
  assert.equal(hasAnswerGenerationEvidence("partial output", {}, false), true);
});

test("decorative terminal shell cannot masquerade as generation liveness", () => {
  const evidence = classifyAnswerEvidence("", {
    stopActive: false,
    copyReady: false,
    finishedTextVisible: true,
    bodyHasModelFooter: true
  });

  assert.deepEqual(evidence, {
    candidateLength: 0,
    substantiveOutput: false,
    activeGeneration: false,
    terminalUiHint: true,
    hasGenerationEvidence: false
  });
});

test("active generation and extracted output remain unbounded answer evidence", () => {
  assert.equal(classifyAnswerEvidence("", { stopActive: true }).hasGenerationEvidence, true);
  assert.equal(classifyAnswerEvidence("partial answer", { stopActive: false }).hasGenerationEvidence, true);
});

test("insert verification escalates to submit fallback instead of wedging forever", () => {
  assert.equal(
    shouldAttemptSubmitAfterInsert(
      { inputLength: 91716, submitReady: false, url: "https://www.notion.so/ai" },
      120000,
      120000
    ),
    true
  );
  assert.equal(
    shouldAttemptSubmitAfterInsert(
      { inputLength: 91716, submitReady: true, url: "https://www.notion.so/ai" },
      120000,
      120000
    ),
    false
  );
  assert.equal(
    shouldAttemptSubmitAfterInsert(
      { inputLength: 91716, submitReady: false, url: "https://www.notion.so/chat?t=owned" },
      120000,
      120000
    ),
    false
  );
});

test("composer clipping detection does not enforce stale automated readback ceilings", () => {
  assert.equal(composerLooksClipped("x".repeat(123000), { inputLength: 100000 }), false);
  assert.equal(composerLooksClipped("x".repeat(540000), { inputLength: 100000 }), false);
  assert.equal(composerLooksClipped("x".repeat(90000), { inputLength: 90000 }), false);
  assert.equal(composerLooksClipped("x".repeat(90000), { inputLength: 50000 }), false);
});

test("visible enabled button descriptors are active", () => {
  assert.deepEqual(
    visibleEnabledButtonState({ found: true, visible: true, disabled: false, ariaDisabled: "" }),
    { found: true, visible: true, enabled: true, active: true }
  );
});

test("hidden stop button descriptors are not active", () => {
  assert.equal(
    visibleEnabledButtonState({ found: true, visible: false, disabled: false, ariaDisabled: "" }).active,
    false
  );
  assert.equal(
    visibleEnabledButtonState({ found: true, visible: false, disabled: false, ariaDisabled: "false" }).enabled,
    false
  );
});

test("disabled or aria-disabled button descriptors are not active", () => {
  assert.equal(
    visibleEnabledButtonState({ found: true, visible: true, disabled: true, ariaDisabled: "" }).active,
    false
  );
  assert.equal(
    visibleEnabledButtonState({ found: true, visible: true, disabled: false, ariaDisabled: "true" }).active,
    false
  );
});

test("missing button descriptors are not active", () => {
  assert.deepEqual(
    visibleEnabledButtonState(null),
    { found: false, visible: false, enabled: false, active: false }
  );
});

test("complete JSON artifacts are detected without accepting partial JSON", () => {
  assert.equal(looksLikeCompleteJsonArtifact('{"ok":true,"items":[1,2]}'), true);
  assert.equal(looksLikeCompleteJsonArtifact('[{"ok":true}]'), true);
  assert.equal(looksLikeCompleteJsonArtifact('{"ok":true'), false);
  assert.equal(looksLikeCompleteJsonArtifact('Here is {"ok":true}'), false);
  assert.equal(looksLikeCompleteJsonArtifact(''), false);
});
