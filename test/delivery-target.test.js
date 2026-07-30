import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN_CONTEXT_ID,
  normalizeContextId,
  sendCardToTarget,
  sendApprovalCardToTarget,
  sendTextToTarget,
} from "../src/delivery-target.js";

test("normalizes missing delivery contexts to main", () => {
  assert.equal(normalizeContextId(), MAIN_CONTEXT_ID);
  assert.equal(normalizeContextId(""), MAIN_CONTEXT_ID);
  assert.equal(normalizeContextId("   "), MAIN_CONTEXT_ID);
  assert.equal(normalizeContextId(" om_root "), "om_root");
});

test("sends main-context text and cards directly to the chat", async () => {
  const calls = [];
  const lark = {
    async sendText(...args) { calls.push(["text", ...args]); return "text-result"; },
    async sendApprovalCard(...args) { calls.push(["card", ...args]); return "card-result"; },
    async replyText() { throw new Error("must not reply"); },
    async replyApprovalCard() { throw new Error("must not reply"); },
  };
  assert.equal(await sendTextToTarget(
    lark,
    { chatId: "oc_1" },
    "hello",
    "text-key",
  ), "text-result");
  assert.equal(await sendApprovalCardToTarget(
    lark,
    { chatId: "oc_1", contextId: "main" },
    { card: true },
    "card-key",
  ), "card-result");
  assert.deepEqual(calls, [
    ["text", "oc_1", "hello", "text-key"],
    ["card", "oc_1", { card: true }, "card-key"],
  ]);
});

test("replies inside a topic for topic-context text and cards", async () => {
  const calls = [];
  const lark = {
    async sendText() { throw new Error("must not send to main"); },
    async sendApprovalCard() { throw new Error("must not send to main"); },
    async replyText(...args) { calls.push(["text", ...args]); return "text-result"; },
    async replyApprovalCard(...args) { calls.push(["card", ...args]); return "card-result"; },
  };
  assert.equal(await sendTextToTarget(
    lark,
    { chatId: "oc_1", contextId: "om_root" },
    "hello",
    "text-key",
  ), "text-result");
  assert.equal(await sendApprovalCardToTarget(
    lark,
    { chatId: "oc_1", contextId: "om_root" },
    { card: true },
    "card-key",
  ), "card-result");
  assert.deepEqual(calls, [
    ["text", "om_root", "hello", "text-key", { replyInThread: true }],
    ["card", "om_root", { card: true }, "card-key", { replyInThread: true }],
  ]);
});

test("does not fall back to the main chat when a topic reply fails", async () => {
  let mainSends = 0;
  const lark = {
    async sendText() { mainSends += 1; },
    async replyText() { throw new Error("topic unavailable"); },
  };
  await assert.rejects(
    sendTextToTarget(
      lark,
      { chatId: "oc_1", contextId: "om_root" },
      "hello",
      "text-key",
    ),
    /topic unavailable/,
  );
  assert.equal(mainSends, 0);
});

test("routes generic control cards without changing approval-card compatibility", async () => {
  const calls = [];
  const lark = {
    async sendCard(...args) { calls.push(["send", ...args]); return { messageId: "om_main" }; },
    async replyCard(...args) { calls.push(["reply", ...args]); return { messageId: "om_topic" }; },
  };
  await sendCardToTarget(lark, { chatId: "oc_1" }, { task: 1 }, "main-key");
  await sendCardToTarget(
    lark,
    { chatId: "oc_1", contextId: "om_root" },
    { task: 2 },
    "topic-key",
  );
  assert.deepEqual(calls, [
    ["send", "oc_1", { task: 1 }, "main-key"],
    ["reply", "om_root", { task: 2 }, "topic-key", { replyInThread: true }],
  ]);
});
