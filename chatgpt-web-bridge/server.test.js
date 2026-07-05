"use strict";

const assert = require("assert");
const test = require("node:test");
const { buildPrompt, cleanAssistantText, openAiResponse, normalizeForAnchor, promptAnchors } = require("./server");

test("buildPrompt preserves provider-style roles", () => {
  const prompt = buildPrompt({
    messages: [
      { role: "system", content: "Answer exactly." },
      { role: "user", content: "Reply with ok." }
    ]
  }, "req-123");

  assert.match(prompt, /BRIDGE_REQUEST_ID: req-123/);
  assert.match(prompt, /system:\nAnswer exactly\./);
  assert.match(prompt, /user:\nReply with ok\./);
  assert.doesNotMatch(prompt, /Conversation so far/);
});

test("buildPrompt handles legacy prompt payload", () => {
  const prompt = buildPrompt({ prompt: "hello" }, "req-abc");
  assert.strictEqual(prompt, "BRIDGE_REQUEST_ID: req-abc\n\nhello");
});

test("buildPrompt includes response_format without proof language", () => {
  const prompt = buildPrompt({
    messages: [{ role: "user", content: "name=lex" }],
    response_format: { type: "json_object" }
  }, "req-json");

  assert.match(prompt, /response_format:/);
  assert.match(prompt, /"json_object"/);
  assert.doesNotMatch(prompt, /prove|verified/i);
});

test("cleanAssistantText removes common UI footer noise", () => {
  const text = cleanAssistantText("result\nCopy\nGood response\nBad response");
  assert.strictEqual(text, "result");
});

test("openAiResponse returns choices[0].message.content", () => {
  const response = openAiResponse("hello", { model: "custom" });
  assert.strictEqual(response.choices[0].message.content, "hello");
  assert.strictEqual(response.choices[0].message.role, "assistant");
  assert.strictEqual(response.model, "custom");
});

test("prompt insertion anchors tolerate whitespace reshaping", () => {
  const prompt = buildPrompt({
    messages: [{ role: "user", content: "Reply only: {\"chatgpt_bridge\":\"ok\"}" }]
  }, "req-space");
  const observed = "Ask anything\nBRIDGE_REQUEST_ID: req-space\n\nuser:\nReply only: {\"chatgpt_bridge\":\"ok\"}";
  const missing = promptAnchors(prompt, "req-space").filter((anchor) => !normalizeForAnchor(observed).includes(normalizeForAnchor(anchor)));
  assert.deepStrictEqual(missing, []);
});
