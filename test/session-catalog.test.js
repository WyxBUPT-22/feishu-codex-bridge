import assert from "node:assert/strict";
import test from "node:test";
import { SessionCatalog } from "../src/session-catalog.js";
import { baseConfig } from "./helpers.js";

const scope = { senderId: "ou_1", chatId: "oc_1", repository: "repo" };

function thread(overrides = {}) {
  return {
    id: "01900000-0000-7000-8000-000000000001",
    cwd: "C:\\repo",
    name: "Desktop session",
    preview: "hello",
    source: "vscode",
    status: { type: "idle" },
    modelProvider: "private",
    updatedAt: 1_783_961_552,
    ...overrides,
  };
}

function fixture() {
  const config = baseConfig("C:\\repo");
  config.codex.provider = { id: "private" };
  const data = [thread(), thread({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cwd: "C:\\other" })];
  const client = { async listThreads() { return { data }; } };
  return new SessionCatalog(client, config, { clock: () => 1000, cacheTtlMs: 5000 });
}

test("lists only exact allowlisted repository sessions", async () => {
  const catalog = fixture();
  const sessions = await catalog.list(scope);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].source, "vscode");
  assert.match(catalog.format(sessions), /Desktop session/);
});

test("resolves cached numbers and validated id prefixes", async () => {
  const catalog = fixture();
  await catalog.list(scope);
  assert.equal((await catalog.resolve(scope, "1")).id.slice(0, 8), "01900000");
  assert.equal((await catalog.resolve(scope, "01900000")).id.slice(0, 8), "01900000");
});

test("rejects provider mismatch", async () => {
  const catalog = fixture();
  catalog.config.codex.provider.id = "other-provider";
  await catalog.list(scope);
  await assert.rejects(catalog.resolve(scope, "1"), (error) => error.code === "provider_mismatch");
});

test("keeps numeric selection caches isolated by conversation context", async () => {
  const catalog = fixture();
  const alpha = { ...scope, contextId: "thread-alpha" };
  const beta = { ...scope, contextId: "thread-beta" };
  await catalog.list(alpha);

  assert.equal((await catalog.resolve(alpha, "1")).id.slice(0, 8), "01900000");
  await assert.rejects(
    catalog.resolve(beta, "1"),
    (error) => error.code === "selection_expired",
  );
});

test("treats omitted catalog context as main", async () => {
  const catalog = fixture();
  await catalog.list(scope);
  assert.equal(
    (await catalog.resolve({ ...scope, contextId: "main" }, "1")).id.slice(0, 8),
    "01900000",
  );
});
