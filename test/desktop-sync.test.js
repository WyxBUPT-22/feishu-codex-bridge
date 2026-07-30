import assert from "node:assert/strict";
import test from "node:test";
import { DesktopSync } from "../src/desktop-sync.js";
import { baseConfig } from "./helpers.js";

function syncConfig() {
  const config = baseConfig();
  config.lark.allowedSenders = ["ou_1", "ou_2"];
  return config;
}

function topicSyncConfig() {
  const config = syncConfig();
  config.lark.allowedChats = ["oc_1"];
  config.lark.workbenchChats = ["oc_1"];
  config.lark.p2pOnly = false;
  return config;
}

test("notifies Feishu only for new external completed turns", async () => {
  const binding = {
    senderId: "ou_1", chatId: "oc_1", repository: "repo", threadId: "thread-1",
  };
  let turns = [{ id: "turn-1", status: "completed", completedAt: 1, items: [] }];
  const client = { async listTurns() { return { data: turns }; } };
  const sessions = { listBindings: () => [binding] };
  const messages = [];
  const lark = { async sendText(chatId, text) { messages.push({ chatId, text }); } };
  const stateRecord = { threadId: "thread-1" };
  const store = {
    listJobs: () => [],
    sessionKey: () => "scope",
    state: { sessions: { scope: stateRecord } },
    async save() {},
  };
  const sync = new DesktopSync({ client, sessions, lark, config: syncConfig(), store });
  await sync.poll();
  assert.equal(messages.length, 0);
  turns = [
    {
      id: "turn-2",
      status: "completed",
      completedAt: 2,
      items: [
        { type: "userMessage", content: [{ type: "text", text: "电脑问题" }] },
        { type: "agentMessage", text: "电脑回答", phase: "final_answer" },
      ],
    },
    { id: "turn-1", status: "completed", completedAt: 1, items: [] },
  ];
  await sync.poll();
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /电脑问题/);
  assert.match(messages[0].text, /电脑回答/);
  assert.equal(stateRecord.lastSyncedTurnId, "turn-2");
});

test("notifies every external turn after the persisted cursor in order", async () => {
  const binding = {
    senderId: "ou_1",
    chatId: "oc_1",
    repository: "repo",
    threadId: "thread-1",
    lastSyncedTurnId: "turn-1",
  };
  const turns = [
    { id: "turn-3", status: "completed", completedAt: 3, items: [] },
    { id: "turn-2", status: "completed", completedAt: 2, items: [] },
    { id: "turn-1", status: "completed", completedAt: 1, items: [] },
  ];
  const messages = [];
  const stateRecord = { threadId: "thread-1", lastSyncedTurnId: "turn-1" };
  const sync = new DesktopSync({
    client: { async listTurns() { return { data: turns }; } },
    sessions: { listBindings: () => [binding] },
    lark: { async sendText(chatId, text, key) { messages.push({ chatId, text, key }); } },
    config: syncConfig(),
    store: {
      listJobs: () => [],
      sessionKey: () => "scope",
      state: { sessions: { scope: stateRecord } },
      async save() {},
    },
  });
  await sync.poll();
  assert.equal(messages.length, 2);
  assert.match(messages[0].key, /turn-2$/);
  assert.match(messages[1].key, /turn-3$/);
  assert.equal(stateRecord.lastSyncedTurnId, "turn-3");
});

test("reports a gap instead of replaying when the cursor is outside the page", async () => {
  const binding = {
    senderId: "ou_1",
    chatId: "oc_1",
    repository: "repo",
    threadId: "thread-1",
    lastSyncedTurnId: "old-turn",
  };
  const messages = [];
  const stateRecord = { threadId: "thread-1", lastSyncedTurnId: "old-turn" };
  const sync = new DesktopSync({
    client: {
      async listTurns() {
        return { data: [{ id: "turn-9", status: "completed", completedAt: 9, items: [] }] };
      },
    },
    sessions: { listBindings: () => [binding] },
    lark: { async sendText(chatId, text) { messages.push({ chatId, text }); } },
    config: syncConfig(),
    store: {
      listJobs: () => [],
      sessionKey: () => "scope",
      state: { sessions: { scope: stateRecord } },
      async save() {},
    },
  });
  await sync.poll();
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /同步游标/);
  assert.equal(stateRecord.lastSyncedTurnId, "turn-9");
});

test("does not advance the cursor when Feishu delivery fails", async () => {
  const binding = {
    senderId: "ou_1",
    chatId: "oc_1",
    repository: "repo",
    threadId: "thread-1",
    lastSyncedTurnId: "turn-1",
  };
  const stateRecord = { threadId: "thread-1", lastSyncedTurnId: "turn-1" };
  const sync = new DesktopSync({
    client: {
      async listTurns() {
        return { data: [
          { id: "turn-2", status: "completed", completedAt: 2, items: [] },
          { id: "turn-1", status: "completed", completedAt: 1, items: [] },
        ] };
      },
    },
    sessions: { listBindings: () => [binding] },
    lark: { async sendText() { throw new Error("offline"); } },
    config: syncConfig(),
    store: {
      listJobs: () => [],
      sessionKey: () => "scope",
      state: { sessions: { scope: stateRecord } },
      async save() {},
    },
  });
  await sync.poll();
  assert.equal(stateRecord.lastSyncedTurnId, "turn-1");
});

test("preserves API order when completed turns share a timestamp", async () => {
  const binding = {
    senderId: "ou_1", chatId: "oc_1", repository: "repo", threadId: "thread-1",
    lastSyncedTurnId: "turn-1",
  };
  const messages = [];
  const stateRecord = { threadId: "thread-1", lastSyncedTurnId: "turn-1" };
  const sync = new DesktopSync({
    client: {
      async listTurns(threadId, params) {
        assert.equal(threadId, "thread-1");
        assert.equal(params.sortDirection, "desc");
        return { data: [
          { id: "turn-2", status: "completed", completedAt: 10, items: [] },
          { id: "turn-1", status: "completed", completedAt: 10, items: [] },
        ] };
      },
    },
    sessions: { listBindings: () => [binding] },
    lark: { async sendText(chatId, text, key) { messages.push({ chatId, text, key }); } },
    config: syncConfig(),
    store: {
      listJobs: () => [],
      sessionKey: () => "scope",
      state: { sessions: { scope: stateRecord } },
      async save() {},
    },
  });
  await sync.poll();
  assert.equal(messages.length, 1);
  assert.match(messages[0].key, /turn-2$/);
  assert.equal(stateRecord.lastSyncedTurnId, "turn-2");
});

test("isolates binding failures and continues with later bindings", async () => {
  const bindings = [
    { senderId: "ou_1", chatId: "oc_1", repository: "repo", threadId: "bad-thread", lastSyncedTurnId: "turn-1" },
    { senderId: "ou_2", chatId: "oc_2", repository: "repo", threadId: "good-thread", lastSyncedTurnId: "turn-1" },
  ];
  const records = {
    bad: { threadId: "bad-thread", lastSyncedTurnId: "turn-1" },
    good: { threadId: "good-thread", lastSyncedTurnId: "turn-1" },
  };
  const messages = [];
  const errors = [];
  const sync = new DesktopSync({
    client: {
      async listTurns(threadId) {
        if (threadId === "bad-thread") throw new Error("broken binding");
        return { data: [
          { id: "turn-2", status: "completed", completedAt: 2, items: [] },
          { id: "turn-1", status: "completed", completedAt: 1, items: [] },
        ] };
      },
    },
    sessions: { listBindings: () => bindings },
    lark: { async sendText(chatId) { messages.push(chatId); } },
    config: syncConfig(),
    store: {
      listJobs: () => [],
      sessionKey: (senderId) => senderId === "ou_1" ? "bad" : "good",
      state: { sessions: records },
      async save() {},
    },
    logger: { error(message) { errors.push(message); } },
  });
  await sync.poll();
  assert.equal(errors.length, 1);
  assert.deepEqual(messages, ["oc_2"]);
  assert.equal(records.good.lastSyncedTurnId, "turn-2");
});

test("does not sync bindings removed from current allowlists", async () => {
  const config = syncConfig();
  config.lark.allowedSenders = ["ou_other"];
  let reads = 0;
  const sync = new DesktopSync({
    client: { async listTurns() { reads += 1; return { data: [] }; } },
    sessions: { listBindings: () => [
      { senderId: "ou_1", chatId: "oc_1", repository: "repo", threadId: "thread-1" },
    ] },
    lark: { async sendText() { throw new Error("must not send"); } },
    config,
    store: { listJobs: () => [], state: { sessions: {} } },
  });
  await sync.poll();
  assert.equal(reads, 0);
});

test("rechecks the binding after reading turns and before sending", async () => {
  const binding = {
    senderId: "ou_1", chatId: "oc_1", repository: "repo", threadId: "thread-1",
    lastSyncedTurnId: "turn-1", bindingGeneration: 1,
  };
  const records = { scope: { threadId: "thread-1", lastSyncedTurnId: "turn-1", bindingGeneration: 1 } };
  let sends = 0;
  const sync = new DesktopSync({
    client: {
      async listTurns() {
        delete records.scope;
        return { data: [
          { id: "turn-2", status: "completed", completedAt: 2, items: [] },
          { id: "turn-1", status: "completed", completedAt: 1, items: [] },
        ] };
      },
    },
    sessions: { listBindings: () => [binding] },
    lark: { async sendText() { sends += 1; } },
    config: syncConfig(),
    store: {
      listJobs: () => [],
      sessionKey: () => "scope",
      state: { sessions: records },
      async save() {},
    },
  });
  await sync.poll();
  assert.equal(sends, 0);
});

test("routes desktop sync into the bound topic and scopes session keys by context", async () => {
  const binding = {
    senderId: "ou_1", chatId: "oc_1", contextId: "om_root", repository: "repo",
    threadId: "thread-1", lastSyncedTurnId: "turn-1",
  };
  const stateRecord = { threadId: "thread-1", lastSyncedTurnId: "turn-1" };
  const replies = [];
  const sessionKeyCalls = [];
  const sync = new DesktopSync({
    client: {
      async listTurns() {
        return { data: [
          { id: "turn-2", status: "completed", completedAt: 2, items: [] },
          { id: "turn-1", status: "completed", completedAt: 1, items: [] },
        ] };
      },
    },
    sessions: { listBindings: () => [binding] },
    lark: {
      async sendText() { throw new Error("must not send to main"); },
      async replyText(...args) { replies.push(args); },
    },
    config: topicSyncConfig(),
    store: {
      listJobs: () => [],
      sessionKey(...args) { sessionKeyCalls.push(args); return "scope"; },
      state: { sessions: { scope: stateRecord } },
      async save() {},
    },
  });
  await sync.poll();
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], "om_root");
  assert.match(replies[0][2], /desktop-sync:om_root:/);
  assert.deepEqual(replies[0][3], { replyInThread: true });
  assert.ok(sessionKeyCalls.length >= 2);
  assert.ok(sessionKeyCalls.every((args) => args[3] === "om_root"));
  assert.equal(stateRecord.lastSyncedTurnId, "turn-2");
});

test("does not advance a topic cursor or send to main when the topic reply fails", async () => {
  const binding = {
    senderId: "ou_1", chatId: "oc_1", contextId: "om_root", repository: "repo",
    threadId: "thread-1", lastSyncedTurnId: "turn-1",
  };
  const stateRecord = { threadId: "thread-1", lastSyncedTurnId: "turn-1" };
  let mainSends = 0;
  const sync = new DesktopSync({
    client: {
      async listTurns() {
        return { data: [
          { id: "turn-2", status: "completed", completedAt: 2, items: [] },
          { id: "turn-1", status: "completed", completedAt: 1, items: [] },
        ] };
      },
    },
    sessions: { listBindings: () => [binding] },
    lark: {
      async sendText() { mainSends += 1; },
      async replyText() { throw new Error("topic unavailable"); },
    },
    config: topicSyncConfig(),
    store: {
      listJobs: () => [],
      sessionKey: () => "scope",
      state: { sessions: { scope: stateRecord } },
      async save() {},
    },
    logger: { error() {} },
  });
  await sync.poll();
  assert.equal(mainSends, 0);
  assert.equal(stateRecord.lastSyncedTurnId, "turn-1");
});
