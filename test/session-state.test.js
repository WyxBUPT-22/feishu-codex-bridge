import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionState } from "../src/session-state.js";
import { StateStore } from "../src/state-store.js";

const scope = { senderId: "ou_1", chatId: "oc_1", repository: "repo" };

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-session-state-"));
  const store = new StateStore(directory, 100);
  await store.load();
  let now = Date.parse("2026-07-14T00:00:00.000Z");
  const sessions = new SessionState(store, {
    clock: () => now,
    defaultLeaseTtlMs: 1000,
    maxLeaseTtlMs: 10_000,
  });
  return { directory, store, sessions, advance: (milliseconds) => { now += milliseconds; } };
}

function rejectsCode(promise, code) {
  return assert.rejects(promise, (error) => error?.code === code);
}

function acquireLease(sessions, targetScope, options) {
  const snapshot = sessions.getSnapshot(targetScope);
  return sessions.acquireLease(targetScope, {
    ...options,
    expectedThreadId: snapshot.threadId,
    expectedBindingGeneration: snapshot.bindingGeneration,
  });
}

function takeoverLease(sessions, targetScope, options) {
  const snapshot = sessions.getSnapshot(targetScope);
  return sessions.takeoverLease(targetScope, {
    ...options,
    expectedThreadId: snapshot.threadId,
    expectedBindingGeneration: snapshot.bindingGeneration,
  });
}

test("loads legacy bindings and persists enriched binding metadata", async () => {
  const { directory, store, sessions } = await fixture();
  store.state.sessions[store.sessionKey(scope.senderId, scope.chatId, scope.repository)] = {
    threadId: "legacy-thread",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
  await store.save();

  const legacy = sessions.getBinding(scope);
  assert.equal(legacy.threadId, "legacy-thread");
  assert.equal(legacy.contextId, "main");
  assert.equal(legacy.source, "legacy");
  assert.equal(legacy.bindingGeneration, 1);
  assert.equal(legacy.leaseGeneration, 0);
  assert.equal(sessions.listBindings()[0].threadId, "legacy-thread");

  await sessions.bind(scope, { threadId: "legacy-thread", title: "Desktop work", source: "desktop" });
  const reloadedStore = new StateStore(directory, 100);
  await reloadedStore.load();
  const reloaded = new SessionState(reloadedStore);
  const binding = reloaded.getBinding(scope);
  assert.equal(binding.threadId, "legacy-thread");
  assert.equal(binding.title, "Desktop work");
  assert.equal(binding.source, "desktop");
  assert.equal(binding.bindingGeneration, 1);
});

test("restart recovery migrates legacy bindings even without a lease", async () => {
  const { directory, store, sessions } = await fixture();
  store.state.sessions[store.sessionKey(scope.senderId, scope.chatId, scope.repository)] = {
    threadId: "legacy-thread",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
  await store.save();
  assert.equal(store.state.sessions[store.sessionKey(scope.senderId, scope.chatId, scope.repository)].bindingGeneration, undefined);
  assert.deepEqual(await sessions.recoverAfterRestart(), []);

  const reloadedStore = new StateStore(directory, 100);
  await reloadedStore.load();
  const record = reloadedStore.state.sessions[reloadedStore.sessionKey(scope.senderId, scope.chatId, scope.repository)];
  assert.equal(record.threadId, "legacy-thread");
  assert.equal(record.bindingGeneration, 1);
  assert.equal(record.leaseGeneration, 0);
  assert.equal(record.source, "legacy");
  assert.equal(record.senderId, scope.senderId);
  assert.equal(record.contextId, "main");
});

test("bindings and leases are isolated by conversation context", async () => {
  const { sessions } = await fixture();
  const alpha = { ...scope, contextId: "thread-alpha" };
  const beta = { ...scope, contextId: "thread-beta" };

  await sessions.bind(scope, { threadId: "thread-main", source: "feishu" });
  await sessions.bind(alpha, { threadId: "thread-alpha-codex", source: "feishu" });
  await sessions.bind(beta, { threadId: "thread-beta-codex", source: "feishu" });

  assert.equal(sessions.getBinding({ ...scope, contextId: "main" }).threadId, "thread-main");
  assert.equal(sessions.getBinding(alpha).threadId, "thread-alpha-codex");
  assert.equal(sessions.getBinding(beta).threadId, "thread-beta-codex");
  assert.deepEqual(
    sessions.listBindings({ contextId: "thread-alpha" }).map((binding) => binding.threadId),
    ["thread-alpha-codex"],
  );

  const alphaLease = await acquireLease(sessions, alpha, { owner: "job-alpha" });
  const betaLease = await acquireLease(sessions, beta, { owner: "job-beta" });
  assert.equal(alphaLease.binding.contextId, "thread-alpha");
  assert.equal(betaLease.binding.contextId, "thread-beta");
  await sessions.releaseLease(alpha, alphaLease.token);
  assert.equal(sessions.getBinding(beta).lease.owner, "job-beta");
  await sessions.releaseLease(beta, betaLease.token);
});

test("leases are exclusive, renewable and fenced after release", async () => {
  const { sessions } = await fixture();
  await sessions.bind(scope, { threadId: "thread-1", source: "feishu" });
  const first = await acquireLease(sessions, scope, { owner: "job-1" });

  await rejectsCode(acquireLease(sessions, scope, { owner: "job-2" }), "lease_conflict");
  const renewed = await sessions.renewLease(scope, first.token, { ttlMs: 2000 });
  assert.equal(renewed.token.generation, first.token.generation);
  const released = await sessions.releaseLease(scope, first.token);
  assert.equal(released.lease, null);
  assert.ok(released.leaseGeneration > first.token.generation);
  await rejectsCode(sessions.renewLease(scope, first.token), "lease_missing");

  const second = await acquireLease(sessions, scope, { owner: "job-2" });
  assert.ok(second.token.generation > first.token.generation);
});

test("concurrent lease attempts have exactly one winner", async () => {
  const { sessions } = await fixture();
  await sessions.bind(scope, { threadId: "thread-1" });
  const attempts = await Promise.allSettled([
    acquireLease(sessions, scope, { owner: "desktop" }),
    acquireLease(sessions, scope, { owner: "mobile" }),
  ]);

  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = attempts.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "lease_conflict");
});

test("lease acquisition atomically validates the queued binding snapshot", async () => {
  const { sessions } = await fixture();
  const original = await sessions.bind(scope, { threadId: "thread-1" });
  let markBlockerEntered;
  let releaseBlocker;
  const blockerEntered = new Promise((resolve) => { markBlockerEntered = resolve; });
  const blocker = sessions.runExclusive(async () => {
    markBlockerEntered();
    await new Promise((resolve) => { releaseBlocker = resolve; });
  });
  await blockerEntered;
  const replacement = sessions.bind(
    scope,
    { threadId: "thread-2" },
    { replace: true, expectedBindingGeneration: original.bindingGeneration },
  );
  const acquisition = sessions.acquireLease(scope, {
    owner: "queued-job",
    expectedThreadId: original.threadId,
    expectedBindingGeneration: original.bindingGeneration,
  });
  releaseBlocker();

  await blocker;
  await replacement;
  await rejectsCode(acquisition, "binding_changed");
  assert.equal(sessions.getBinding(scope).threadId, "thread-2");
  assert.equal(sessions.getBinding(scope).lease, null);
});

test("stale binding expectations cannot lease a replacement thread", async () => {
  const { sessions } = await fixture();
  const original = await sessions.bind(scope, { threadId: "thread-1" });
  await sessions.bind(
    scope,
    { threadId: "thread-2" },
    { replace: true, expectedBindingGeneration: original.bindingGeneration },
  );

  await rejectsCode(
    sessions.acquireLease(scope, {
      owner: "stale-job",
      expectedThreadId: original.threadId,
      expectedBindingGeneration: original.bindingGeneration,
    }),
    "binding_changed",
  );
  assert.equal(sessions.getBinding(scope).lease, null);
});

test("expired leases can be cleaned and reacquired with a newer generation", async () => {
  const { sessions, advance } = await fixture();
  await sessions.bind(scope, { threadId: "thread-1" });
  const first = await acquireLease(sessions, scope, { owner: "desktop", ttlMs: 500 });
  advance(501);

  assert.equal(sessions.getBinding(scope).lease.active, false);
  const cleaned = await sessions.cleanupExpiredLeases();
  assert.equal(cleaned.length, 1);
  assert.equal(sessions.getBinding(scope).lease, null);
  const second = await acquireLease(sessions, scope, { owner: "mobile" });
  assert.ok(second.token.generation > first.token.generation);
});

test("restart recovery preserves bindings and invalidates persisted owners", async () => {
  const { directory, sessions } = await fixture();
  await sessions.bind(scope, { threadId: "thread-1", title: "Handoff" });
  const beforeRestart = await acquireLease(sessions, scope, { owner: "job-before-restart" });

  const reloadedStore = new StateStore(directory, 100);
  await reloadedStore.load();
  const afterRestart = new SessionState(reloadedStore, {
    clock: () => Date.parse("2026-07-14T00:00:00.500Z"),
  });
  const recovered = await afterRestart.recoverAfterRestart();
  assert.equal(recovered.length, 1);
  assert.equal(afterRestart.getBinding(scope).threadId, "thread-1");
  assert.equal(afterRestart.getBinding(scope).lease, null);
  await rejectsCode(afterRestart.releaseLease(scope, beforeRestart.token), "lease_missing");

  const next = await acquireLease(afterRestart, scope, { owner: "job-after-restart" });
  assert.ok(next.token.generation > beforeRestart.token.generation);
});

test("takeover requires the observed generation and fences the old owner", async () => {
  const { sessions } = await fixture();
  await sessions.bind(scope, { threadId: "thread-1" });
  const desktop = await acquireLease(sessions, scope, { owner: "desktop" });

  await rejectsCode(
    takeoverLease(sessions, scope, { owner: "mobile", observedGeneration: 999 }),
    "generation_mismatch",
  );
  const mobile = await takeoverLease(sessions, scope, {
    owner: "mobile",
    observedGeneration: desktop.token.generation,
    reason: "confirmed_by_user",
  });
  assert.equal(mobile.previousLease.owner, "desktop");
  assert.ok(mobile.token.generation > desktop.token.generation);
  await rejectsCode(sessions.renewLease(scope, desktop.token), "lease_fenced");
  await sessions.renewLease(scope, mobile.token);
});

test("takeover reserves an idle binding and excludes new leases until release", async () => {
  const { sessions } = await fixture();
  const binding = await sessions.bind(scope, { threadId: "thread-1" });
  const reservation = await sessions.takeoverLease(scope, {
    owner: "takeover:message-1",
    observedGeneration: binding.leaseGeneration,
    expectedThreadId: binding.threadId,
    expectedBindingGeneration: binding.bindingGeneration,
  });

  assert.equal(reservation.previousLease, null);
  await rejectsCode(
    sessions.acquireLease(scope, {
      owner: "job:racing-continue",
      expectedThreadId: binding.threadId,
      expectedBindingGeneration: binding.bindingGeneration,
    }),
    "lease_conflict",
  );
  await sessions.releaseLease(scope, reservation.token);
  const next = await sessions.acquireLease(scope, {
    owner: "job:after-takeover",
    expectedThreadId: binding.threadId,
    expectedBindingGeneration: binding.bindingGeneration,
  });
  assert.equal(next.binding.lease.owner, "job:after-takeover");
});

test("fork commit atomically switches the binding and returns a new lease token", async () => {
  const { sessions } = await fixture();
  await sessions.bind(scope, { threadId: "source-thread", title: "Original" });
  const sourceLease = await acquireLease(sessions, scope, { owner: "fork-job" });

  const fork = await sessions.commitFork(scope, sourceLease.token, {
    sourceThreadId: "source-thread",
    newThreadId: "fork-thread",
    title: "Safe branch",
  });
  assert.equal(fork.binding.threadId, "fork-thread");
  assert.equal(fork.binding.forkedFromThreadId, "source-thread");
  assert.equal(fork.binding.title, "Safe branch");
  assert.ok(fork.token.generation > sourceLease.token.generation);
  await rejectsCode(sessions.releaseLease(scope, sourceLease.token), "lease_fenced");
  await sessions.releaseLease(scope, fork.token);
});

test("replacement and detach use optimistic generation checks and reject active leases", async () => {
  const { sessions } = await fixture();
  const original = await sessions.bind(scope, { threadId: "thread-1" });

  await rejectsCode(
    sessions.bind(scope, { threadId: "thread-2" }, { replace: true }),
    "expected_generation_required",
  );
  const lease = await acquireLease(sessions, scope, { owner: "running-job" });
  await rejectsCode(
    sessions.bind(
      scope,
      { threadId: "thread-2" },
      { replace: true, expectedBindingGeneration: original.bindingGeneration },
    ),
    "lease_conflict",
  );
  await sessions.releaseLease(scope, lease.token);
  const replacement = await sessions.bind(
    scope,
    { threadId: "thread-2", source: "desktop" },
    { replace: true, expectedBindingGeneration: original.bindingGeneration },
  );
  assert.equal(replacement.threadId, "thread-2");

  await rejectsCode(
    sessions.detach(scope, { expectedBindingGeneration: original.bindingGeneration }),
    "generation_mismatch",
  );
  await sessions.detach(scope, { expectedBindingGeneration: replacement.bindingGeneration });
  assert.equal(sessions.getBinding(scope), null);
});

test("switching threads clears the previous desktop-sync cursor", async () => {
  const { store, sessions } = await fixture();
  const first = await sessions.bind(scope, { threadId: "thread-1" });
  const key = store.sessionKey(scope.senderId, scope.chatId, scope.repository);
  store.state.sessions[key].lastSyncedTurnId = "turn-old";
  store.state.sessions[key].lastSyncedAt = "2026-07-14T00:00:00.000Z";
  await store.save();
  const replacement = await sessions.bind(
    scope,
    { threadId: "thread-2" },
    { replace: true, expectedBindingGeneration: first.bindingGeneration },
  );
  assert.equal(replacement.lastSyncedTurnId, undefined);
  assert.equal(replacement.lastSyncedAt, undefined);
});

test("bind can establish or advance the desktop-sync cursor atomically", async () => {
  const { sessions } = await fixture();
  const first = await sessions.bind(scope, {
    threadId: "thread-1",
    lastSyncedTurnId: "turn-1",
  });
  assert.equal(first.lastSyncedTurnId, "turn-1");
  assert.ok(first.lastSyncedAt);

  const advanced = await sessions.bind(scope, {
    threadId: "thread-1",
    lastSyncedTurnId: "turn-2",
  }, { expectedBindingGeneration: first.bindingGeneration });
  assert.equal(advanced.lastSyncedTurnId, "turn-2");

  const replacement = await sessions.bind(scope, {
    threadId: "thread-2",
    lastSyncedTurnId: "turn-3",
  }, {
    replace: true,
    expectedBindingGeneration: advanced.bindingGeneration,
  });
  assert.equal(replacement.lastSyncedTurnId, "turn-3");
});
