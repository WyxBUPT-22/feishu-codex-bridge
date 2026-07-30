import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config.js";

function rawConfig() {
  return {
    version: 1,
    lark: { allowedSenders: ["ou_allowed"] },
    repositories: { repo: { path: path.resolve(".") } },
    defaultRepository: "repo",
  };
}

test("normalizes safe defaults", () => {
  const config = normalizeConfig(rawConfig());
  assert.equal(config.codex.sandbox, "workspace-write");
  assert.equal(config.codex.approvalPolicy, "never");
  assert.equal(config.lark.p2pOnly, true);
  assert.deepEqual(config.lark.workbenchChats, []);
  assert.deepEqual(config.lark.allowedMessageTypes, ["text", "post"]);
  assert.equal(config.desktopSync.pollIntervalMs, 5_000);
});

test("rejects unsafe approval and sandbox policies", () => {
  const approval = rawConfig();
  approval.codex = { approvalPolicy: "on-request" };
  assert.throws(() => normalizeConfig(approval), /approvalPolicy must be never/);

  const sandbox = rawConfig();
  sandbox.codex = { sandbox: "danger-full-access" };
  assert.throws(() => normalizeConfig(sandbox), /sandbox must be read-only or workspace-write/);
});

test("requires sender allowlist and absolute repositories", () => {
  const noSenders = rawConfig();
  noSenders.lark.allowedSenders = [];
  assert.throws(() => normalizeConfig(noSenders), /allowedSenders must not be empty/);

  const relative = rawConfig();
  relative.repositories.repo.path = ".";
  assert.throws(() => normalizeConfig(relative), /path must be absolute/);
});

test("requires explicit workbench chats for group mode", () => {
  const group = rawConfig();
  group.lark.p2pOnly = false;
  assert.throws(() => normalizeConfig(group), /workbenchChats must not be empty/);
});

test("normalizes valid workbench chats that are part of the chat allowlist", () => {
  const group = rawConfig();
  group.lark.allowedChats = ["oc_private", "oc_workbench", "oc_workbench"];
  group.lark.workbenchChats = ["oc_workbench", "oc_workbench"];
  group.lark.p2pOnly = false;

  const config = normalizeConfig(group);
  assert.deepEqual(config.lark.allowedChats, ["oc_private", "oc_workbench"]);
  assert.deepEqual(config.lark.workbenchChats, ["oc_workbench"]);
});

test("rejects malformed or non-allowlisted workbench chats", () => {
  const malformed = rawConfig();
  malformed.lark.allowedChats = ["oc_workbench"];
  malformed.lark.workbenchChats = ["not_a_chat"];
  assert.throws(() => normalizeConfig(malformed), /workbenchChats entry must be an oc_ chat_id/);

  const outsideAllowlist = rawConfig();
  outsideAllowlist.lark.allowedChats = ["oc_private"];
  outsideAllowlist.lark.workbenchChats = ["oc_workbench"];
  assert.throws(() => normalizeConfig(outsideAllowlist), /must also appear in lark.allowedChats/);
});

test("keeps runtime state outside managed repositories", () => {
  const config = rawConfig();
  config.dataDirectory = path.join(config.repositories.repo.path, ".data");
  assert.throws(() => normalizeConfig(config), /dataDirectory must be outside/);
});

test("accepts only explicit HTTPS responses providers", () => {
  const config = rawConfig();
  config.codex = {
    model: "gpt-test",
    provider: {
      id: "private_provider",
      name: "Private Provider",
      baseUrl: "https://example.test/v1",
      wireApi: "responses",
      requiresOpenAIAuth: true,
    },
  };
  assert.equal(normalizeConfig(config).codex.provider.id, "private_provider");

  config.codex.provider.baseUrl = "http://example.test/v1";
  assert.throws(() => normalizeConfig(config), /must use https/);
});

test("requires single concurrency for deterministic sessions", () => {
  const config = rawConfig();
  config.queue = { concurrency: 2 };
  assert.throws(() => normalizeConfig(config), /concurrency must be 1/);
});

test("validates and preserves the desktop sync polling interval", () => {
  const config = rawConfig();
  config.desktopSync = { pollIntervalMs: 2_500 };
  assert.equal(normalizeConfig(config).desktopSync.pollIntervalMs, 2_500);

  for (const pollIntervalMs of [999, 60_001, 1_500.5, "invalid"]) {
    config.desktopSync.pollIntervalMs = pollIntervalMs;
    assert.throws(
      () => normalizeConfig(config),
      /desktopSync\.pollIntervalMs must be an integer between 1000 and 60000/,
    );
  }
});
