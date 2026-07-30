import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.js";

test("persists dedupe keys, repository preferences and sessions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-state-"));
  const store = new StateStore(directory, 100);
  await store.load();
  await store.markProcessed("om_1");
  await store.setRepository("ou_1", "oc_1", "repo");
  await store.setSession("ou_1", "oc_1", "repo", "thread-1");

  const reloaded = new StateStore(directory, 100);
  await reloaded.load();
  assert.equal(reloaded.hasProcessed("om_1"), true);
  assert.equal(reloaded.getRepository("ou_1", "oc_1", "fallback"), "repo");
  assert.equal(reloaded.getSession("ou_1", "oc_1", "repo").threadId, "thread-1");
  assert.doesNotMatch(await readFile(path.join(directory, "state.json"), "utf8"), /undefined/);
});

test("bounds processed message history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-state-"));
  const store = new StateStore(directory, 2);
  await store.load();
  await store.markProcessed("a");
  await store.markProcessed("b");
  await store.markProcessed("c");
  assert.equal(store.hasProcessed("a"), false);
  assert.deepEqual(store.state.processedMessages, ["b", "c"]);
});

test("persists approval mode without overwriting repository preferences", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-state-"));
  const store = new StateStore(directory, 100);
  await store.load();

  assert.equal(store.getApprovalMode("ou_1", "oc_1"), "balanced");
  await store.setApprovalMode("ou_1", "oc_1", "strict");
  await store.setRepository("ou_1", "oc_1", "repo");
  assert.equal(store.getApprovalMode("ou_1", "oc_1"), "strict");

  await store.setApprovalMode("ou_1", "oc_1", "auto");
  assert.equal(store.getRepository("ou_1", "oc_1", "fallback"), "repo");
  assert.equal(store.getApprovalMode("ou_1", "oc_1", "thread:alpha"), "balanced");
  await assert.rejects(
    store.setApprovalMode("ou_1", "oc_1", "unsafe"),
    /invalid approval mode: unsafe/,
  );

  const reloaded = new StateStore(directory, 100);
  await reloaded.load();
  assert.equal(reloaded.getApprovalMode("ou_1", "oc_1"), "auto");
  assert.equal(reloaded.getRepository("ou_1", "oc_1", "fallback"), "repo");
});

test("keeps legacy main keys while isolating repository and session state by context", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-state-"));
  const store = new StateStore(directory, 100);
  await store.load();

  assert.equal(store.conversationKey("ou_1", "oc_1"), "ou_1:oc_1");
  assert.equal(store.conversationKey("ou_1", "oc_1", "main"), "ou_1:oc_1");
  assert.equal(store.sessionKey("ou_1", "oc_1", "repo"), "ou_1:oc_1:repo");

  await store.setRepository("ou_1", "oc_1", "main-repo");
  await store.setRepository("ou_1", "oc_1", "topic-repo", "thread:alpha");
  assert.equal(store.getRepository("ou_1", "oc_1", "fallback"), "main-repo");
  assert.equal(
    store.getRepository("ou_1", "oc_1", "fallback", "thread:alpha"),
    "topic-repo",
  );
  assert.equal(store.getRepository("ou_1", "oc_1", "fallback", "thread:beta"), "fallback");

  await store.setSession("ou_1", "oc_1", "repo", "thread-main");
  await store.setSession("ou_1", "oc_1", "repo", "thread-topic", "thread:alpha");
  assert.equal(store.getSession("ou_1", "oc_1", "repo").threadId, "thread-main");
  assert.equal(
    store.getSession("ou_1", "oc_1", "repo", "thread:alpha").threadId,
    "thread-topic",
  );
  assert.equal(
    store.getSession("ou_1", "oc_1", "repo", "thread:alpha").contextId,
    "thread:alpha",
  );

  await store.clearSession("ou_1", "oc_1", "repo", "thread:alpha");
  assert.equal(store.getSession("ou_1", "oc_1", "repo", "thread:alpha"), null);
  assert.equal(store.getSession("ou_1", "oc_1", "repo").threadId, "thread-main");
});

test("does not prune jobs that are waiting on a thread-conflict decision", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-state-"));
  const store = new StateStore(directory, 100, 2);
  await store.load();
  await store.putJob({ id: "waiting", status: "waiting_conflict", createdAt: "2026-01-01" });
  await store.putJob({ id: "old", status: "completed", createdAt: "2026-01-02" });
  await store.putJob({ id: "new", status: "completed", createdAt: "2026-01-03" });

  assert.equal(store.getJob("waiting").status, "waiting_conflict");
  assert.equal(store.getJob("old"), null);
  assert.equal(store.getJob("new").status, "completed");
});
