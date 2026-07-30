import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskControlAction,
  TaskControlCards,
  taskControlCard,
} from "../src/task-control-cards.js";

function job(overrides = {}) {
  return {
    id: "a1b2c3d4e5",
    repository: "repo",
    approvalMode: "balanced",
    senderId: "ou_1",
    chatId: "oc_1",
    contextId: "main",
    ...overrides,
  };
}

test("renders pending approvals, settled feedback, stats, and a stop action", () => {
  const state = {
    job: job(),
    status: "running",
    progress: "Reading files",
    stats: { automatic: 2, manual: 1 },
    approvals: new Map([["a".repeat(32), {
      actionId: "a".repeat(32), summary: "Run tests", status: "pending",
    }]]),
  };
  const card = taskControlCard(state);
  assert.equal(card.header.template, "orange");
  const actions = card.elements.filter((element) => element.tag === "action");
  assert.equal(actions.length, 2);
  assert.equal(actions[0].actions[0].value.kind, "codex_approval");
  assert.equal(actions[1].actions[0].value.kind, "codex_task_control");
  assert.match(JSON.stringify(card), /自动 2 次，人工 1 次/);
});

test("serializes task card updates and never lets an older PATCH finish last", async () => {
  const updates = [];
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const lark = {
    async sendCard() { return { messageId: "om_control" }; },
    async updateMessageCard(_messageId, card) {
      updates.push(card.header.title.content);
      if (updates.length === 1) await first;
      return { code: 0 };
    },
  };
  const cards = new TaskControlCards({ lark, logger: { error() {} } });
  await cards.create(job());
  const running = cards.setStatus("a1b2c3d4e5", "running");
  const completed = cards.setStatus("a1b2c3d4e5", "completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates.length, 1);
  releaseFirst();
  await Promise.all([running, completed]);
  assert.match(updates[0], /正在执行/);
  assert.match(updates[1], /已完成/);
});

test("falls back when approval cannot be written to the shared card", async () => {
  const lark = {
    async sendCard() { return { messageId: "om_control" }; },
    async updateMessageCard() { throw new Error("PATCH unavailable"); },
  };
  const cards = new TaskControlCards({ lark, logger: { error() {} } });
  await cards.create(job());
  assert.equal(await cards.addApproval({
    job: job(),
    actionId: "a".repeat(32),
    summary: "Run tests",
    confirmation: "abcdef",
    expiresAt: Date.now() + 60_000,
  }), null);
});

test("renders an approval timeout differently from an explicit rejection", async () => {
  const updates = [];
  const lark = {
    async sendCard() { return { messageId: "om_control" }; },
    async updateMessageCard(_messageId, card) { updates.push(card); return { code: 0 }; },
  };
  const cards = new TaskControlCards({ lark, logger: { error() {} } });
  await cards.create(job());
  await cards.addApproval({
    job: job(),
    actionId: "a".repeat(32),
    summary: "Run remote check",
    confirmation: "abcdef",
    expiresAt: Date.now() + 60_000,
  });
  await cards.settleApproval("a1b2c3d4e5", "a".repeat(32), false, "timeout");
  const rendered = JSON.stringify(updates.at(-1));
  assert.match(rendered, /已超时/);
  assert.doesNotMatch(rendered, /已拒绝/);
});

test("accepts only exact stop payloads and exact card ownership", async () => {
  const action = JSON.stringify({
    v: 1, kind: "codex_task_control", action: "stop", jobId: "a1b2c3d4e5",
  });
  assert.deepEqual(parseTaskControlAction(action), { action: "stop", jobId: "a1b2c3d4e5" });
  assert.equal(parseTaskControlAction(JSON.stringify({
    v: 1, kind: "codex_task_control", action: "stop", jobId: "a1b2c3d4e5", extra: true,
  })), null);
  const lark = {
    async sendCard() { return { messageId: "om_control" }; },
    async updateMessageCard() { return { code: 0 }; },
  };
  const cards = new TaskControlCards({ lark, logger: { error() {} } });
  await cards.create(job());
  assert.equal(cards.validateStop({
    jobId: "a1b2c3d4e5", senderId: "ou_1", chatId: "oc_1", messageId: "om_control",
  })?.id, "a1b2c3d4e5");
  assert.equal(cards.validateStop({
    jobId: "a1b2c3d4e5", senderId: "ou_other", chatId: "oc_1", messageId: "om_control",
  }), null);
});

test("renders thread-conflict choices and accepts only an exact one-time token", async () => {
  const token = "b".repeat(32);
  const updates = [];
  const lark = {
    async sendCard() { return { messageId: "om_control" }; },
    async updateMessageCard(_messageId, card) { updates.push(card); return { code: 0 }; },
  };
  const cards = new TaskControlCards({ lark, logger: { error() {} } });
  await cards.create(job());
  assert.equal(await cards.showThreadConflict("a1b2c3d4e5", {
    token,
    progress: "Thread is active",
  }), true);

  const rendered = updates.at(-1);
  assert.match(rendered.header.title.content, /会话占用/);
  const choices = rendered.elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions)
    .filter((action) => action.value.kind === "codex_thread_conflict");
  assert.deepEqual(choices.map((choice) => choice.value.action), ["wait", "fork", "cancel"]);
  for (const choice of choices) {
    assert.deepEqual(parseTaskControlAction(JSON.stringify(choice.value)), {
      action: choice.value.action,
      jobId: "a1b2c3d4e5",
      token,
    });
  }
  assert.equal(parseTaskControlAction(JSON.stringify({
    ...choices[0].value,
    injected: true,
  })), null);
  assert.equal(cards.validateThreadConflict({
    jobId: "a1b2c3d4e5",
    token,
    senderId: "ou_1",
    chatId: "oc_1",
    messageId: "om_control",
  })?.id, "a1b2c3d4e5");
  assert.equal(cards.validateThreadConflict({
    jobId: "a1b2c3d4e5",
    token: "c".repeat(32),
    senderId: "ou_1",
    chatId: "oc_1",
    messageId: "om_control",
  }), null);

  await cards.setThreadConflictPhase("a1b2c3d4e5", token, "waiting_thread", {
    progress: "Waiting",
  });
  assert.equal(cards.validateThreadConflict({
    jobId: "a1b2c3d4e5",
    token,
    senderId: "ou_1",
    chatId: "oc_1",
    messageId: "om_control",
  }), null);
});
