import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server-client.js";

const tool = { command: "codex", prefixArgs: [], displayName: "codex" };

test("resolves responses and emits notifications", async () => {
  const client = new CodexAppServerClient(tool);
  const writes = [];
  client.child = { stdin: { writable: true, write: (value) => writes.push(JSON.parse(value)) } };
  const request = client.request("thread/list", {});
  assert.equal(writes[0].method, "thread/list");
  client.handleLine(JSON.stringify({ id: writes[0].id, result: { data: [] } }));
  assert.deepEqual(await request, { data: [] });

  const notification = new Promise((resolve) => client.once("turn/completed", resolve));
  client.handleLine(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }));
  assert.equal((await notification).turn.status, "completed");
});

test("stores scoped environment overrides for app-server startup", () => {
  const client = new CodexAppServerClient(tool, {
    environmentOverrides: { CODEX_HOME: "C:\\isolated" },
  });
  assert.deepEqual(client.environmentOverrides, { CODEX_HOME: "C:\\isolated" });
});

test("lists threads across providers instead of inheriting the isolated default", async () => {
  const client = new CodexAppServerClient(tool);
  const writes = [];
  client.child = { stdin: { writable: true, write: (value) => writes.push(JSON.parse(value)) } };
  const request = client.listThreads();
  assert.deepEqual(writes[0].params.modelProviders, []);
  client.handleLine(JSON.stringify({ id: writes[0].id, result: { data: [] } }));
  await request;
});

test("declines approval requests by default", () => {
  const client = new CodexAppServerClient(tool);
  const writes = [];
  client.child = { stdin: { writable: true, write: (value) => writes.push(JSON.parse(value)) } };
  client.handleLine(JSON.stringify({
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: { command: "danger" },
  }));
  assert.deepEqual(writes[0], { id: 7, result: { decision: "decline" } });
});

test("routes approval requests through an asynchronous handler", async () => {
  const client = new CodexAppServerClient(tool, {
    approvalHandler: async () => ({ decision: "accept" }),
  });
  const writes = [];
  client.child = { stdin: { writable: true, write: (value) => writes.push(JSON.parse(value)) } };
  client.handleLine(JSON.stringify({
    id: 8,
    method: "item/commandExecution/requestApproval",
    params: { command: "safe" },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes[0], { id: 8, result: { decision: "accept" } });
});

test("reports malformed protocol messages without crashing", () => {
  const client = new CodexAppServerClient(tool);
  let warning;
  client.on("warning", (value) => { warning = value; });
  assert.doesNotThrow(() => client.handleLine("not-json"));
  assert.match(warning, /Invalid app-server JSON/);
});

test("routes protocol error notifications without triggering EventEmitter crashes", () => {
  const client = new CodexAppServerClient(tool);
  const notifications = [];
  const appServerErrors = [];
  client.on("notification", (message) => notifications.push(message));
  client.on("app-server-error", (params) => appServerErrors.push(params));
  const message = {
    method: "error",
    params: {
      error: { message: "Reconnecting... 1/5" },
      willRetry: true,
      threadId: "thread-1",
      turnId: "turn-1",
    },
  };

  assert.doesNotThrow(() => client.handleLine(JSON.stringify(message)));
  assert.deepEqual(notifications, [message]);
  assert.deepEqual(appServerErrors, [message.params]);
  assert.equal(client.listenerCount("error"), 0);
});

test("conservatively resolves user input and MCP elicitation requests", () => {
  const client = new CodexAppServerClient(tool);
  const writes = [];
  client.child = { stdin: { writable: true, write: (value) => writes.push(JSON.parse(value)) } };
  client.handleLine(JSON.stringify({
    id: 9,
    method: "item/tool/requestUserInput",
    params: { questions: [{ id: "choice" }] },
  }));
  client.handleLine(JSON.stringify({
    id: 10,
    method: "mcpServer/elicitation/request",
    params: { mode: "form" },
  }));
  assert.deepEqual(writes[0], { id: 9, result: { answers: { choice: { answers: [] } } } });
  assert.deepEqual(writes[1], { id: 10, result: { action: "decline", content: null, _meta: null } });
});

test("interrupts a turn after returning an empty permission grant", async () => {
  const client = new CodexAppServerClient(tool);
  const writes = [];
  client.child = { stdin: { writable: true, write: (value) => writes.push(JSON.parse(value)) } };
  client.handleLine(JSON.stringify({
    id: 11,
    method: "item/permissions/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1" },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes[0], {
    id: 11,
    result: { permissions: {}, scope: "turn", strictAutoReview: true },
  });
  assert.equal(writes[1].method, "turn/interrupt");
  client.handleLine(JSON.stringify({ id: writes[1].id, result: {} }));
});
