import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Bridge } from "../src/bridge.js";
import { StateStore } from "../src/state-store.js";
import { baseConfig, cardActionEvent, messageEvent } from "./helpers.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-bridge-"));
  const config = baseConfig(directory);
  config.dataDirectory = path.join(directory, ".data");
  const store = new StateStore(config.dataDirectory, 100);
  await store.load();
  const replies = [];
  const sent = [];
  const lark = {
    async replyText(messageId, text, idempotencyKey, options) {
      replies.push({
        messageId,
        text,
        idempotencyKey,
        ...(options ? { options } : {}),
      });
    },
    async sendText(chatId, text, idempotencyKey) {
      sent.push({ chatId, text, idempotencyKey });
    },
    async getMessageContext(messageId) {
      return {
        messageId,
        chatId: "oc_1",
        threadId: null,
        rootId: null,
        parentId: null,
      };
    },
  };
  const runs = [];
  const codex = Object.assign(new EventEmitter(), {
    async run(job, options) {
      runs.push({ job, options });
      return {
        code: 0,
        signal: null,
        threadId: "thread-1",
        lastMessage: "任务完成",
        errors: [],
        completed: true,
        timedOut: false,
      };
    },
    cancel() { return true; },
  });
  const bridge = new Bridge({ config, store, lark, codex, logger: { warn() {}, error() {} } });
  return { bridge, codex, config, store, replies, runs, sent };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("restart recovery interrupts the exact orphaned turn without touching other turns", async () => {
  const { bridge, store } = await fixture();
  const warnings = [];
  bridge.logger = { warn(message) { warnings.push(message); }, error() {} };
  await store.putJob({
    id: "orphaned-job",
    status: "running",
    repository: "repo",
    threadId: "thread-1",
    turnId: "turn-orphaned",
  });
  await store.putJob({
    id: "old-interrupted-job",
    status: "interrupted",
    repository: "repo",
    threadId: "thread-2",
    turnId: "turn-old",
  });
  await store.putJob({
    id: "failed-orphaned-job",
    status: "failed",
    repository: "repo",
    threadId: "thread-3",
    turnId: "turn-failed-orphaned",
  });
  const interrupts = [];
  const resumes = [];
  bridge.codex.threadOptions = (repositoryPath) => ({ cwd: repositoryPath });
  bridge.appServer = {
    async resumeThread(params) {
      resumes.push(params);
      return { thread: { id: params.threadId, status: { type: "active" } } };
    },
    async listTurns(threadId) {
      if (threadId === "thread-1") {
        return { data: [
          { id: "turn-desktop", status: "inProgress" },
          { id: "turn-orphaned", status: "inProgress" },
        ] };
      }
      if (threadId === "thread-3") {
        return { data: [
          { id: "turn-other-client", status: "inProgress" },
          { id: "turn-failed-orphaned", status: "inProgress" },
        ] };
      }
      return { data: [{ id: "turn-old", status: "completed" }] };
    },
    async interruptTurn(threadId, turnId) {
      interrupts.push({ threadId, turnId });
    },
  };

  await bridge.recoverInterruptedJobs();

  assert.equal(store.getJob("orphaned-job").status, "interrupted");
  assert.deepEqual(resumes, [
    { threadId: "thread-1", cwd: bridge.config.repositories.repo.path, excludeTurns: true },
    { threadId: "thread-2", cwd: bridge.config.repositories.repo.path, excludeTurns: true },
    { threadId: "thread-3", cwd: bridge.config.repositories.repo.path, excludeTurns: true },
  ]);
  assert.deepEqual(interrupts, [
    { threadId: "thread-1", turnId: "turn-orphaned" },
    { threadId: "thread-3", turnId: "turn-failed-orphaned" },
  ]);
  assert.match(warnings[0], /Interrupted orphaned Codex turn turn-orphaned/);
});

test("restart recovery remains available when orphan reconciliation fails", async () => {
  const { bridge, store } = await fixture();
  const warnings = [];
  bridge.logger = { warn(message) { warnings.push(message); }, error() {} };
  await store.putJob({
    id: "unreadable-job",
    status: "running",
    threadId: "thread-1",
    turnId: "turn-1",
  });
  bridge.appServer = {
    async listTurns() { throw new Error("temporary read failure"); },
  };

  await bridge.recoverInterruptedJobs();

  assert.equal(store.getJob("unreadable-job").status, "interrupted");
  assert.match(warnings[0], /Could not reconcile recovered job unreadable-job/);
});

test("handles help once and deduplicates repeated delivery", async () => {
  const { bridge, replies } = await fixture();
  const event = messageEvent({ content: "/help" });
  await bridge.handleEvent(event);
  await bridge.handleEvent(event);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /\/task/);
});

test("queries and changes the approval mode for the current conversation", async () => {
  const { bridge, store, replies } = await fixture();
  await bridge.handleEvent(messageEvent({
    event_id: "evt_approval_query",
    message_id: "om_approval_query",
    content: "/approval",
  }));
  assert.match(replies.at(-1).text, /balanced（均衡）/);

  await bridge.handleEvent(messageEvent({
    event_id: "evt_approval_strict",
    message_id: "om_approval_strict",
    content: "/approval strict",
  }));
  assert.equal(store.getApprovalMode("ou_allowed", "oc_1"), "strict");
  assert.match(replies.at(-1).text, /strict（严格）/);

  await bridge.handleEvent(messageEvent({
    event_id: "evt_approval_status",
    message_id: "om_approval_status",
    content: "/status",
  }));
  assert.match(replies.at(-1).text, /审批模式：strict（严格）/);
});

test("rejects non-allowlisted events without replying", async () => {
  const { bridge, replies } = await fixture();
  const result = await bridge.handleEvent(messageEvent({ sender_id: "ou_intruder" }));
  assert.equal(result.reason, "sender_not_allowed");
  assert.equal(replies.length, 0);
});

test("routes a valid approval card click once through the card decision path", async () => {
  const { bridge, replies } = await fixture();
  const decisions = [];
  const updates = [];
  bridge.lark.updateApprovalCard = async (token, card, operatorId) => {
    updates.push({ token, card, operatorId });
  };
  bridge.approvalBroker = {
    decideCard(input) {
      decisions.push(input);
      return {
        ok: true,
        approved: true,
        job: { id: "job-card" },
        card: { header: { template: "green" }, elements: [] },
      };
    },
  };
  const event = cardActionEvent();
  const first = await bridge.handleEvent(event);
  const duplicate = await bridge.handleEvent(event);
  assert.equal(first.accepted, true);
  assert.equal(duplicate.reason, "duplicate");
  assert.deepEqual(decisions, [{
    senderId: "ou_allowed",
    chatId: "oc_1",
    messageId: "om_card1",
    actionId: "a".repeat(32),
    approved: true,
  }]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].messageId, "om_card1");
  assert.match(replies[0].text, /job-card/);
  assert.deepEqual(updates, [{
    token: "card-update-token",
    card: { header: { template: "green" }, elements: [] },
    operatorId: "ou_allowed",
  }]);
});

test("updates the shared control card without sending an extra approval message", async () => {
  const { bridge, replies } = await fixture();
  const settled = [];
  bridge.taskControlCards = {
    async settleApproval(...args) { settled.push(args); return true; },
  };
  bridge.approvalBroker = {
    decideCard() {
      return {
        ok: true,
        approved: true,
        job: { id: "job-card" },
        actionId: "a".repeat(32),
        presentation: "control",
        card: null,
      };
    },
  };
  const result = await bridge.handleEvent(cardActionEvent({ event_id: "evt_control_approval" }));
  assert.equal(result.accepted, true);
  assert.deepEqual(settled, [["job-card", "a".repeat(32), true, "card_approved"]]);
  assert.equal(replies.length, 0);
});

test("accepts a stop button only from the exact task control card owner", async () => {
  const { bridge } = await fixture();
  const job = {
    id: "a1b2c3d4e5", senderId: "ou_allowed", chatId: "oc_1",
  };
  const statuses = [];
  bridge.taskControlCards = {
    validateStop(input) {
      return input.messageId === "om_card1" && input.senderId === "ou_allowed" ? job : null;
    },
    async setStatus(...args) { statuses.push(args); return true; },
  };
  bridge.requestJobCancellation = async (candidate) => (
    candidate === job ? { type: "running", stopped: true } : null
  );
  const result = await bridge.handleEvent(cardActionEvent({
    event_id: "evt_task_stop",
    action_value: JSON.stringify({
      v: 1,
      kind: "codex_task_control",
      action: "stop",
      jobId: "a1b2c3d4e5",
    }),
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.result.stopped, true);
  assert.equal(statuses[0][1], "canceling");
});

test("waits for an unknown active turn and retries without interrupting it", async () => {
  const { bridge, codex, store, replies } = await fixture();
  const cards = [];
  bridge.lark.sendCard = async (_chatId, card) => {
    cards.push(card);
    return { messageId: "om_conflict_wait" };
  };
  bridge.lark.updateMessageCard = async (_messageId, card) => {
    cards.push(card);
    return { code: 0 };
  };
  const scope = { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" };
  await bridge.sessions.bind(scope, { threadId: "thread-busy" });
  let runCount = 0;
  codex.run = async () => {
    runCount += 1;
    if (runCount === 1) {
      const error = new Error("Thread thread-busy already has an active turn");
      error.code = "THREAD_BUSY";
      error.threadId = "thread-busy";
      error.conflictingTurnId = "desktop-turn";
      throw error;
    }
    return {
      code: 0,
      signal: null,
      threadId: "thread-busy",
      turnId: "mobile-turn",
      lastMessage: "continued safely",
      errors: [],
      completed: true,
      timedOut: false,
    };
  };
  let desktopActive = true;
  let turnReads = 0;
  const interrupts = [];
  bridge.appServer = {
    async listTurns() {
      turnReads += 1;
      return {
        data: desktopActive
          ? [{ id: "desktop-turn", status: "inProgress" }]
          : [{ id: "desktop-turn", status: "completed" }],
        nextCursor: null,
      };
    },
    async interruptTurn(threadId, turnId) { interrupts.push({ threadId, turnId }); },
  };
  bridge.threadConflictPollMs = 5;

  await bridge.handleEvent(messageEvent({
    event_id: "evt_busy_wait_task",
    message_id: "om_busy_wait_task",
    content: "/continue continue safely",
  }));
  await waitFor(() => store.listJobs().some((job) => job.status === "waiting_conflict"));
  await waitFor(() => cards.some((card) => card.elements
    .flatMap((element) => element.actions ?? [])
    .some((button) => button.value?.action === "wait")));
  const conflictCard = cards.at(-1);
  const waitValue = conflictCard.elements
    .flatMap((element) => element.actions ?? [])
    .find((button) => button.value?.action === "wait").value;
  const click = await bridge.handleEvent(cardActionEvent({
    event_id: "evt_busy_wait_click",
    message_id: "om_conflict_wait",
    action_value: JSON.stringify(waitValue),
  }));
  assert.equal(click.accepted, true);
  const waitingConflict = [...bridge.threadConflicts.values()][0];
  assert.equal(waitingConflict.phase, "wait");
  assert.ok(waitingConflict.timer);
  await waitFor(() => turnReads > 0 || bridge.lifecycleErrors.length > 0);
  assert.deepEqual(bridge.lifecycleErrors, []);
  assert.equal(runCount, 1);
  desktopActive = false;
  await waitFor(() => runCount === 2);
  await waitFor(() => replies.some((reply) => reply.text.includes("continued safely")));

  assert.deepEqual(interrupts, []);
  assert.equal(store.listJobs().find((job) => job.sourceMessageId === "om_busy_wait_task").status, "completed");
});

test("forks from a safe cutoff on conflict and retries on the new binding", async () => {
  const { bridge, codex, store, replies } = await fixture();
  const cards = [];
  bridge.lark.sendCard = async (_chatId, card) => {
    cards.push(card);
    return { messageId: "om_conflict_fork" };
  };
  bridge.lark.updateMessageCard = async (_messageId, card) => {
    cards.push(card);
    return { code: 0 };
  };
  const scope = { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" };
  await bridge.sessions.bind(scope, {
    threadId: "thread-source",
    title: "Source",
    source: "desktop",
  });
  const runThreads = [];
  codex.run = async (_job, options) => {
    runThreads.push(options.resumeThreadId);
    if (runThreads.length === 1) {
      const error = new Error("Thread thread-source already has an active turn");
      error.code = "THREAD_BUSY";
      error.threadId = "thread-source";
      error.conflictingTurnId = "desktop-turn";
      throw error;
    }
    return {
      code: 0,
      signal: null,
      threadId: "thread-fork",
      turnId: "fork-turn",
      lastMessage: "fork completed",
      errors: [],
      completed: true,
      timedOut: false,
    };
  };
  codex.threadOptions = () => ({ model: "test-model", cwd: "C:\\repo" });
  const forkRequests = [];
  const interrupts = [];
  bridge.appServer = {
    async listTurns() {
      return {
        data: [
          { id: "desktop-turn", status: "inProgress" },
          { id: "safe-turn", status: "completed" },
        ],
        nextCursor: null,
      };
    },
    async forkThread(request) {
      forkRequests.push(request);
      return { thread: { id: "thread-fork" } };
    },
    async interruptTurn(threadId, turnId) { interrupts.push({ threadId, turnId }); },
  };

  await bridge.handleEvent(messageEvent({
    event_id: "evt_busy_fork_task",
    message_id: "om_busy_fork_task",
    content: "/continue fork safely",
  }));
  await waitFor(() => store.listJobs().some((job) => job.status === "waiting_conflict"));
  await waitFor(() => cards.some((card) => card.elements
    .flatMap((element) => element.actions ?? [])
    .some((button) => button.value?.action === "fork")));
  const forkValue = cards.at(-1).elements
    .flatMap((element) => element.actions ?? [])
    .find((button) => button.value?.action === "fork").value;
  const click = await bridge.handleEvent(cardActionEvent({
    event_id: "evt_busy_fork_click",
    message_id: "om_conflict_fork",
    action_value: JSON.stringify(forkValue),
  }));
  assert.equal(click.accepted, true);
  await waitFor(() => replies.some((reply) => reply.text.includes("fork completed")));

  assert.deepEqual(runThreads, ["thread-source", "thread-fork"]);
  assert.equal(forkRequests.length, 1);
  assert.equal(forkRequests[0].lastTurnId, "safe-turn");
  assert.equal(forkRequests[0].approvalPolicy, "never");
  assert.equal(bridge.sessions.getBinding(scope).threadId, "thread-fork");
  assert.deepEqual(interrupts, []);
});

test("rejects a stale conflict token and lets the exact cancel action settle the task", async () => {
  const { bridge, codex, store } = await fixture();
  const cards = [];
  bridge.lark.sendCard = async (_chatId, card) => {
    cards.push(card);
    return { messageId: "om_conflict_cancel" };
  };
  bridge.lark.updateMessageCard = async (_messageId, card) => {
    cards.push(card);
    return { code: 0 };
  };
  const scope = { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" };
  await bridge.sessions.bind(scope, { threadId: "thread-busy" });
  codex.run = async () => {
    const error = new Error("busy");
    error.code = "THREAD_BUSY";
    error.threadId = "thread-busy";
    throw error;
  };

  await bridge.handleEvent(messageEvent({
    event_id: "evt_busy_cancel_task",
    message_id: "om_busy_cancel_task",
    content: "/continue cancel me",
  }));
  await waitFor(() => store.listJobs().some((job) => job.status === "waiting_conflict"));
  await waitFor(() => cards.some((card) => card.elements
    .flatMap((element) => element.actions ?? [])
    .some((button) => button.value?.action === "cancel")));
  const cancelValue = cards.at(-1).elements
    .flatMap((element) => element.actions ?? [])
    .find((button) => button.value?.action === "cancel").value;
  const stale = await bridge.handleEvent(cardActionEvent({
    event_id: "evt_busy_cancel_stale",
    message_id: "om_conflict_cancel",
    action_value: JSON.stringify({ ...cancelValue, token: "f".repeat(32) }),
  }));
  assert.equal(stale.reason, "invalid_thread_conflict");
  assert.equal(store.listJobs().find((job) => job.sourceMessageId === "om_busy_cancel_task").status, "waiting_conflict");

  const canceled = await bridge.handleEvent(cardActionEvent({
    event_id: "evt_busy_cancel_exact",
    message_id: "om_conflict_cancel",
    action_value: JSON.stringify(cancelValue),
  }));
  assert.equal(canceled.accepted, true);
  assert.equal(store.listJobs().find((job) => job.sourceMessageId === "om_busy_cancel_task").status, "canceled");
});

test("keeps an approval settled when the visual card update fails", async () => {
  const { bridge, replies } = await fixture();
  const settled = [];
  bridge.lark.updateApprovalCard = async () => {
    throw new Error("card update unavailable");
  };
  bridge.approvalBroker = {
    decideCard(input) {
      settled.push(input);
      return {
        ok: true,
        approved: true,
        job: { id: "job-card-settled" },
        card: { header: { template: "green" }, elements: [] },
      };
    },
  };

  const result = await bridge.handleEvent(cardActionEvent({ event_id: "evt_card_update_failure" }));

  assert.equal(result.result.ok, true);
  assert.equal(settled.length, 1);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /job-card-settled/);
});

test("rejects malformed approval card payloads before reaching the broker", async () => {
  const { bridge, replies } = await fixture();
  let decisions = 0;
  bridge.approvalBroker = { decideCard() { decisions += 1; } };
  const result = await bridge.handleEvent(cardActionEvent({
    action_value: JSON.stringify({
      v: 1,
      kind: "codex_approval",
      decision: "approve",
      actionId: "a".repeat(32),
      injected: true,
    }),
  }));
  assert.equal(result.reason, "invalid_card_action");
  assert.equal(decisions, 0);
  assert.equal(replies.length, 0);
});

test("runs a task, stores the thread, and replies with the result", async () => {
  const { bridge, store, replies, runs } = await fixture();
  await bridge.handleEvent(messageEvent({ content: "/task 修复测试" }));
  await waitFor(() => replies.some((reply) => reply.text.includes("任务完成")));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].options.prompt, "修复测试");
  assert.equal(store.getSession("ou_allowed", "oc_1", "repo").threadId, "thread-1");
  assert.equal(replies.some((reply) => reply.text.includes("已接收任务")), true);
});

test("uses one control card for task acceptance, progress state, and completion", async () => {
  const { bridge, store, replies } = await fixture();
  const created = [];
  const updates = [];
  bridge.lark.sendCard = async (chatId, card) => {
    created.push({ chatId, card });
    return { messageId: "om_task_control" };
  };
  bridge.lark.updateMessageCard = async (messageId, card) => {
    updates.push({ messageId, card });
    return { code: 0 };
  };

  await bridge.handleEvent(messageEvent({
    event_id: "evt_control_task",
    message_id: "om_control_task_source",
    content: "/task control card task",
  }));
  await waitFor(() => replies.some((reply) => reply.text.includes("任务完成")));

  const stored = store.listJobs().find((candidate) => (
    candidate.sourceMessageId === "om_control_task_source"
  ));
  assert.equal(stored.controlCardMessageId, "om_task_control");
  assert.equal(created.length, 1);
  assert.equal(replies.some((reply) => reply.text.includes("已接收任务")), false);
  assert.equal(updates.every((update) => update.messageId === "om_task_control"), true);
  assert.match(updates.at(-1).card.header.title.content, /已完成/);
});

test("freezes the selected approval mode onto each queued job", async () => {
  const { bridge, store, replies, runs } = await fixture();
  await store.setApprovalMode("ou_allowed", "oc_1", "auto");

  await bridge.handleEvent(messageEvent({
    event_id: "evt_auto_task",
    message_id: "om_auto_task",
    content: "/task 自动审批任务",
  }));
  await waitFor(() => runs.length === 1);

  assert.equal(runs[0].job.approvalMode, "auto");
  const stored = store.listJobs().find((job) => job.sourceMessageId === "om_auto_task");
  assert.equal(stored.approvalMode, "auto");
  assert.equal(replies.some((reply) => /审批模式：auto（自动）/.test(reply.text)), true);
});

test("includes automatic and manual approval counts in the task result", async () => {
  const { bridge, replies } = await fixture();
  bridge.approvalBroker = {
    declineForJob() {},
    takeJobStats() { return { automatic: 4, manual: 1 }; },
  };

  await bridge.handleEvent(messageEvent({
    event_id: "evt_approval_stats",
    message_id: "om_approval_stats",
    content: "/task 汇总审批",
  }));
  await waitFor(() => replies.some((reply) => reply.text.includes("任务完成")));

  assert.equal(
    replies.some((reply) => reply.text.includes("审批：自动 4 次，人工 1 次。")),
    true,
  );
});

test("sends narrative progress independently from approval cards", async () => {
  const { bridge, sent } = await fixture();
  bridge.progressDebounceMs = 5;
  bridge.progressIntervalMs = 20;
  const job = { id: "job-progress", chatId: "oc_1" };

  bridge.onProgress({ type: "text", delta: "我先检查配置。", job });
  await waitFor(() => sent.length === 1);
  assert.match(sent[0].text, /我先检查配置/);

  bridge.onProgress({ type: "text", delta: "接下来运行诊断。", job });
  bridge.onProgress({ type: "tool", summary: "运行诊断命令", job });
  await waitFor(() => sent.length === 2);
  assert.match(sent[1].text, /接下来运行诊断/);
  assert.match(sent[1].text, /运行诊断命令/);
  assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey);
});

test("does not report a timed-out result as completed when a late final exists", async () => {
  const { bridge, store, replies } = await fixture();
  bridge.codex.run = async () => ({
    code: 0,
    signal: null,
    threadId: "thread-timeout",
    turnId: "turn-timeout",
    lastMessage: "late final must not be reported as success",
    errors: [],
    completed: true,
    timedOut: true,
  });

  await bridge.handleEvent(messageEvent({
    event_id: "evt_timeout_late_final",
    message_id: "om_timeout_late_final",
    content: "/task timeout",
  }));
  await waitFor(() => store.listJobs().some((job) => job.status === "failed"));

  const job = store.listJobs().find((candidate) => (
    candidate.sourceMessageId === "om_timeout_late_final"
  ));
  assert.equal(job.status, "failed");
  assert.equal(job.exitCode, 0);
  assert.equal(replies.some((reply) => (
    reply.text.includes("late final must not be reported as success")
  )), false);
});

test("declines pending approvals as soon as an exact turn becomes terminal", async () => {
  const { bridge, codex } = await fixture();
  const declinedJobs = [];
  const declinedTurns = [];
  bridge.approvalBroker = {
    declineForJob(jobId, reason) { declinedJobs.push({ jobId, reason }); },
    declineForTurn(threadId, turnId, reason) {
      declinedTurns.push({ threadId, turnId, reason });
    },
  };

  codex.emit("turn-terminal", {
    job: { id: "job-terminal" },
    threadId: "thread-terminal",
    turnId: "turn-terminal",
    status: "completed",
  });

  assert.deepEqual(declinedJobs, [{ jobId: "job-terminal", reason: "turn_terminal" }]);
  assert.deepEqual(declinedTurns, [{
    threadId: "thread-terminal",
    turnId: "turn-terminal",
    reason: "turn_terminal",
  }]);
});

test("declines existing approvals on a completed-empty terminal candidate", async () => {
  const { bridge, codex } = await fixture();
  const declinedJobs = [];
  const declinedTurns = [];
  bridge.approvalBroker = {
    declineForJob(jobId, reason) { declinedJobs.push({ jobId, reason }); },
    declineForTurn(threadId, turnId, reason) {
      declinedTurns.push({ threadId, turnId, reason });
    },
  };

  codex.emit("turn-approval-close", {
    job: { id: "job-candidate" },
    threadId: "thread-candidate",
    turnId: "turn-candidate",
    status: "completed",
  });

  assert.deepEqual(declinedJobs, [{
    jobId: "job-candidate",
    reason: "turn_completion_candidate",
  }]);
  assert.deepEqual(declinedTurns, [{
    threadId: "thread-candidate",
    turnId: "turn-candidate",
    reason: "turn_completion_candidate",
  }]);
});

test("shutdown closes ingress, cancels queued work, and drains lifecycle persistence", async () => {
  const { bridge, store, runs } = await fixture();
  let finishRunning;
  bridge.codex.run = async (job, options) => {
    runs.push({ job, options });
    return new Promise((resolve) => { finishRunning = resolve; });
  };

  await bridge.handleEvent(messageEvent({
    event_id: "evt_shutdown_running",
    message_id: "om_shutdown_running",
    content: "/task first",
  }));
  await waitFor(() => typeof finishRunning === "function");
  await bridge.handleEvent(messageEvent({
    event_id: "evt_shutdown_queued",
    message_id: "om_shutdown_queued",
    content: "/task second",
  }));
  assert.equal(bridge.queue.status().pending.length, 1);

  const canceled = bridge.beginShutdown();
  assert.equal(canceled.length, 1);
  assert.deepEqual(await bridge.handleEvent(messageEvent({
    event_id: "evt_shutdown_late",
    message_id: "om_shutdown_late",
    content: "/task late",
  })), { accepted: false, reason: "shutting_down" });

  finishRunning({
    code: 0,
    signal: null,
    threadId: "thread-shutdown",
    lastMessage: "done",
    errors: [],
    completed: true,
    timedOut: false,
  });
  await bridge.waitForIdle();

  const jobs = store.listJobs();
  const queued = jobs.find((job) => job.sourceMessageId === "om_shutdown_queued");
  const running = jobs.find((job) => job.sourceMessageId === "om_shutdown_running");
  assert.equal(queued.status, "canceled");
  assert.equal(running.status, "completed");
  assert.equal(jobs.some((job) => job.sourceMessageId === "om_shutdown_late"), false);
});

test("shutdown cancels a task that was persisted while ingress was closing", async () => {
  const { bridge, store, runs } = await fixture();
  const originalPutJob = store.putJob.bind(store);
  let persisted;
  let releasePut;
  const persistedBarrier = new Promise((resolve) => { persisted = resolve; });
  const releaseBarrier = new Promise((resolve) => { releasePut = resolve; });
  store.putJob = async (job) => {
    await originalPutJob(job);
    persisted();
    await releaseBarrier;
  };

  const handling = bridge.handleEvent(messageEvent({
    event_id: "evt_shutdown_persisting",
    message_id: "om_shutdown_persisting",
    content: "/task racing",
  }));
  await persistedBarrier;
  bridge.beginShutdown();
  releasePut();

  assert.deepEqual(await handling, { accepted: false, reason: "shutting_down" });
  await bridge.waitForIdle();
  const job = store.listJobs().find((candidate) => (
    candidate.sourceMessageId === "om_shutdown_persisting"
  ));
  assert.equal(job.status, "canceled");
  assert.match(job.error, /shut down before the task entered the queue/i);
  assert.equal(runs.length, 0);
  assert.deepEqual(bridge.queue.status(), { pending: [], running: [] });
});

test("shutdown prevents a dequeued task from starting Codex after the active snapshot", async () => {
  const { bridge, store, runs } = await fixture();
  const originalUpdateJob = store.updateJob.bind(store);
  let runningPersisted;
  let releaseRunning;
  const runningBarrier = new Promise((resolve) => { runningPersisted = resolve; });
  const releaseBarrier = new Promise((resolve) => { releaseRunning = resolve; });
  store.updateJob = async (jobId, patch) => {
    const result = await originalUpdateJob(jobId, patch);
    if (patch.status === "running") {
      runningPersisted();
      await releaseBarrier;
    }
    return result;
  };

  await bridge.handleEvent(messageEvent({
    event_id: "evt_shutdown_dequeued",
    message_id: "om_shutdown_dequeued",
    content: "/task dequeued",
  }));
  await runningBarrier;
  assert.equal(bridge.queue.status().running.length, 1);

  bridge.beginShutdown();
  releaseRunning();
  await bridge.waitForIdle();

  const job = store.listJobs().find((candidate) => (
    candidate.sourceMessageId === "om_shutdown_dequeued"
  ));
  assert.equal(job.status, "canceled");
  assert.match(job.error, /shut down before the task started Codex/i);
  assert.equal(runs.length, 0);
});

test("waitForIdle reports a critical queue lifecycle persistence failure", async () => {
  const { bridge, store } = await fixture();
  let finishRunning;
  bridge.codex.run = async () => new Promise((resolve) => { finishRunning = resolve; });

  await bridge.handleEvent(messageEvent({
    event_id: "evt_persist_failure_running",
    message_id: "om_persist_failure_running",
    content: "/task first",
  }));
  await waitFor(() => typeof finishRunning === "function");
  await bridge.handleEvent(messageEvent({
    event_id: "evt_persist_failure_queued",
    message_id: "om_persist_failure_queued",
    content: "/task second",
  }));
  const queuedJob = store.listJobs().find((candidate) => (
    candidate.sourceMessageId === "om_persist_failure_queued"
  ));
  const failure = new Error("state persistence failed");
  const originalUpdateJob = store.updateJob.bind(store);
  store.updateJob = async (jobId, patch) => {
    if (jobId === queuedJob.id && patch.status === "canceled") throw failure;
    return originalUpdateJob(jobId, patch);
  };

  bridge.beginShutdown();
  finishRunning({
    code: 0,
    signal: null,
    threadId: "thread-persist-failure",
    lastMessage: "done",
    errors: [],
    completed: true,
    timedOut: false,
  });

  await assert.rejects(bridge.waitForIdle(), (error) => (
    error instanceof AggregateError && error.errors.includes(failure)
  ));
});

test("continue requires and then uses a stored thread", async () => {
  const { bridge, store, replies, runs } = await fixture();
  await bridge.handleEvent(messageEvent({ event_id: "evt_a", message_id: "om_a", content: "/continue 下一步" }));
  assert.match(replies.at(-1).text, /没有可续接会话/);
  await store.setSession("ou_allowed", "oc_1", "repo", "thread-existing");
  await bridge.handleEvent(messageEvent({ event_id: "evt_b", message_id: "om_b", content: "/continue 下一步" }));
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0].options.resumeThreadId, "thread-existing");
});

test("does not overwrite a binding changed while a new task was running", async () => {
  const { bridge, store, replies } = await fixture();
  let finish;
  bridge.codex.run = async () => new Promise((resolve) => { finish = resolve; });
  await bridge.handleEvent(messageEvent({ content: "/task 新任务" }));
  await waitFor(() => typeof finish === "function");
  const current = bridge.sessions.getBinding({ senderId: "ou_allowed", chatId: "oc_1", repository: "repo" });
  if (current) {
    await bridge.sessions.bind(
      { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" },
      { threadId: "desktop-thread", source: "desktop" },
      { replace: true, expectedBindingGeneration: current.bindingGeneration },
    );
  } else {
    await bridge.sessions.bind(
      { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" },
      { threadId: "desktop-thread", source: "desktop" },
    );
  }
  finish({
    code: 0,
    signal: null,
    threadId: "mobile-thread",
    lastMessage: "完成",
    errors: [],
    completed: true,
    timedOut: false,
  });
  await waitFor(() => replies.some((reply) => reply.text.includes("任务已完成，但会话绑定")));
  assert.equal(store.getSession("ou_allowed", "oc_1", "repo").threadId, "desktop-thread");
});

test("executeJob passes its exact binding snapshot and recoverable turns", async () => {
  const { bridge, runs, store } = await fixture();
  const targetScope = { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" };
  const binding = await bridge.sessions.bind(targetScope, { threadId: "thread-existing" });
  let observedOptions;
  const originalAcquireLease = bridge.sessions.acquireLease.bind(bridge.sessions);
  bridge.sessions.acquireLease = async (scope, options) => {
    observedOptions = options;
    return originalAcquireLease(scope, options);
  };
  await store.putJob({
    id: "failed-history",
    status: "failed",
    repository: targetScope.repository,
    threadId: binding.threadId,
    turnId: "failed-orphan",
  });

  await bridge.executeJob({
    id: "atomic-job",
    senderId: targetScope.senderId,
    chatId: targetScope.chatId,
    repository: targetScope.repository,
    repositoryPath: bridge.config.repositories.repo.path,
    prompt: "continue",
    resumeThreadId: binding.threadId,
    bindingSnapshotGeneration: binding.bindingGeneration,
  });

  assert.deepEqual(observedOptions, {
    owner: "job:atomic-job",
    expectedThreadId: binding.threadId,
    expectedBindingGeneration: binding.bindingGeneration,
  });
  assert.deepEqual(runs[0].options.recoverableTurnIds, ["failed-orphan"]);
  assert.equal(bridge.sessions.getBinding(targetScope).lease, null);
});

test("takeover reserves an idle binding until every active turn is interrupted", async () => {
  const { bridge } = await fixture();
  const targetScope = { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" };
  const binding = await bridge.sessions.bind(targetScope, { threadId: "thread-existing" });
  let markReadStarted;
  let finishRead;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readBarrier = new Promise((resolve) => { finishRead = resolve; });
  const interrupted = [];
  const turns = [
    { id: "turn-complete", status: "completed" },
    { id: "turn-active-1", status: "inProgress" },
    { id: "turn-active-2", status: "inProgress" },
  ];
  let reads = 0;
  bridge.appServer = {
    async listTurns(threadId) {
      assert.equal(threadId, binding.threadId);
      if (reads === 0) {
        markReadStarted();
        await readBarrier;
      }
      reads += 1;
      return { data: turns, nextCursor: null };
    },
    async interruptTurn(threadId, turnId) {
      interrupted.push({ threadId, turnId });
      turns.find((turn) => turn.id === turnId).status = "interrupted";
    },
  };
  const request = messageEvent({ event_id: "evt_takeover_1", message_id: "om_takeover_1" });
  await bridge.takeoverSession(request, null);
  const key = `${targetScope.senderId}:${targetScope.chatId}:${targetScope.repository}`;
  const confirmation = bridge.takeoverConfirmations.get(key).code;
  const takeover = bridge.takeoverSession(
    messageEvent({ event_id: "evt_takeover_2", message_id: "om_takeover_2" }),
    confirmation,
  );
  await readStarted;

  const reserved = bridge.sessions.getBinding(targetScope);
  assert.equal(reserved.lease.active, true);
  assert.equal(reserved.lease.owner, "takeover:om_takeover_2");
  await assert.rejects(
    bridge.sessions.acquireLease(targetScope, {
      owner: "job:racing-continue",
      expectedThreadId: binding.threadId,
      expectedBindingGeneration: binding.bindingGeneration,
    }),
    (error) => error?.code === "lease_conflict",
  );

  finishRead();
  await takeover;
  assert.deepEqual(interrupted, [
    { threadId: binding.threadId, turnId: "turn-active-1" },
    { threadId: binding.threadId, turnId: "turn-active-2" },
  ]);
  assert.equal(bridge.sessions.getBinding(targetScope).lease, null);
});

test("takeover scans older turn pages before reporting success", async () => {
  const { bridge, replies } = await fixture();
  const targetScope = { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" };
  const binding = await bridge.sessions.bind(targetScope, { threadId: "thread-existing" });
  const cursors = [];
  const interrupted = [];
  let staleStatus = "inProgress";
  bridge.appServer = {
    async listTurns(threadId, params) {
      assert.equal(threadId, binding.threadId);
      const cursor = params.cursor ?? null;
      cursors.push(cursor);
      if (cursor == null) {
        return {
          data: [{ id: "turn-recent", status: "completed" }],
          nextCursor: "older-page",
        };
      }
      assert.equal(cursor, "older-page");
      return {
        data: [{ id: "turn-stale", status: staleStatus }],
        nextCursor: null,
      };
    },
    async interruptTurn(threadId, turnId) {
      interrupted.push({ threadId, turnId });
      staleStatus = "interrupted";
    },
  };

  await bridge.takeoverSession(messageEvent({ message_id: "om_takeover_1" }), null);
  const key = `${targetScope.senderId}:${targetScope.chatId}:${targetScope.repository}`;
  const confirmation = bridge.takeoverConfirmations.get(key).code;
  await bridge.takeoverSession(messageEvent({ message_id: "om_takeover_2" }), confirmation);

  assert.deepEqual(interrupted, [
    { threadId: binding.threadId, turnId: "turn-stale" },
  ]);
  assert.deepEqual(cursors, [null, "older-page", null, "older-page"]);
  assert.match(replies.at(-1).text, /接管已完成/);
  assert.equal(bridge.sessions.getBinding(targetScope).lease, null);
});

test("takeover does not cancel a job outside the reserved binding scope", async () => {
  const { bridge, store } = await fixture();
  const targetScope = { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" };
  const binding = await bridge.sessions.bind(targetScope, { threadId: "thread-existing" });
  await bridge.sessions.acquireLease(targetScope, {
    owner: "job:foreign-job",
    expectedThreadId: binding.threadId,
    expectedBindingGeneration: binding.bindingGeneration,
  });
  await store.putJob({
    id: "foreign-job",
    senderId: "ou_someone_else",
    chatId: targetScope.chatId,
    repository: targetScope.repository,
    status: "running",
  });
  const canceled = [];
  bridge.codex.cancel = async (jobId) => {
    canceled.push(jobId);
    return true;
  };

  await bridge.takeoverSession(
    messageEvent({ event_id: "evt_foreign_1", message_id: "om_foreign_1" }),
    null,
  );
  const key = `${targetScope.senderId}:${targetScope.chatId}:${targetScope.repository}`;
  const confirmation = bridge.takeoverConfirmations.get(key).code;
  await bridge.takeoverSession(
    messageEvent({ event_id: "evt_foreign_2", message_id: "om_foreign_2" }),
    confirmation,
  );

  assert.deepEqual(canceled, []);
  assert.equal(store.getJob("foreign-job").status, "running");
  assert.equal(bridge.sessions.getBinding(targetScope).lease, null);
});

test("takeover retains its reservation when a turn interrupt fails", async () => {
  const { bridge, replies } = await fixture();
  const targetScope = { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" };
  const binding = await bridge.sessions.bind(targetScope, { threadId: "thread-existing" });
  bridge.appServer = {
    async listTurns() {
      return { data: [{ id: "turn-active", status: "inProgress" }], nextCursor: null };
    },
    async interruptTurn() { throw new Error("interrupt failed"); },
  };
  await bridge.takeoverSession(messageEvent({ message_id: "om_takeover_1" }), null);
  const key = `${targetScope.senderId}:${targetScope.chatId}:${targetScope.repository}`;
  const confirmation = bridge.takeoverConfirmations.get(key).code;
  await bridge.takeoverSession(messageEvent({ message_id: "om_takeover_2" }), confirmation);
  assert.match(replies.at(-1).text, /接管失败/);
  const reserved = bridge.sessions.getBinding(targetScope);
  assert.equal(reserved.lease.active, true);
  assert.equal(reserved.lease.owner, "takeover:om_takeover_2");
  await assert.rejects(
    bridge.sessions.acquireLease(targetScope, {
      owner: "job:racing-continue",
      expectedThreadId: binding.threadId,
      expectedBindingGeneration: binding.bindingGeneration,
    }),
    (error) => error?.code === "lease_conflict",
  );
});

test("executeJob retains and extends its lease after unconfirmed interruption", async () => {
  const { bridge } = await fixture();
  const targetScope = { senderId: "ou_allowed", chatId: "oc_1", repository: "repo" };
  const binding = await bridge.sessions.bind(targetScope, { threadId: "thread-existing" });
  const error = new Error("interrupt failed");
  error.code = "TURN_INTERRUPT_UNCONFIRMED";
  bridge.codex.run = async () => { throw error; };
  await assert.rejects(bridge.executeJob({
    id: "unsafe-cancel",
    senderId: targetScope.senderId,
    chatId: targetScope.chatId,
    repository: targetScope.repository,
    repositoryPath: bridge.config.repositories.repo.path,
    prompt: "continue",
    resumeThreadId: binding.threadId,
    bindingSnapshotGeneration: binding.bindingGeneration,
  }), (candidate) => candidate === error);
  const retained = bridge.sessions.getBinding(targetScope);
  assert.equal(retained.lease.active, true);
  assert.equal(retained.lease.owner, "job:unsafe-cancel");
  assert.ok(Date.parse(retained.lease.expiresAt) - Date.now() > 10 * 60_000);
});

test("fork passes the complete configured provider registration to app-server", async () => {
  const { bridge, config, replies } = await fixture();
  config.codex.model = "gpt-provider-test";
  config.codex.provider = {
    id: "example_provider",
    name: "Example Provider",
    baseUrl: "https://example.test/v1",
    wireApi: "responses",
    requiresOpenAIAuth: true,
  };
  bridge.catalog = {
    async resolve() {
      return {
        id: "thread-source",
        name: "Source thread",
        status: { type: "idle" },
      };
    },
  };
  bridge.codex.threadOptions = (repositoryPath) => ({
    model: config.codex.model,
    modelProvider: config.codex.provider.id,
    cwd: repositoryPath,
    runtimeWorkspaceRoots: [repositoryPath],
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: config.codex.sandbox,
    config: {
      model_provider: config.codex.provider.id,
      model_providers: {
        [config.codex.provider.id]: {
          name: config.codex.provider.name,
          base_url: config.codex.provider.baseUrl,
          wire_api: config.codex.provider.wireApi,
          requires_openai_auth: true,
        },
      },
    },
  });
  let forkRequest;
  bridge.appServer = {
    async forkThread(request) {
      forkRequest = request;
      return { thread: { id: "thread-fork" } };
    },
    async listTurns() {
      return { data: [{ id: "turn-completed", status: "completed" }] };
    },
  };

  await bridge.forkSession(messageEvent({ message_id: "om_fork" }), "thread-source");

  assert.equal(forkRequest.threadId, "thread-source");
  assert.equal(forkRequest.modelProvider, "example_provider");
  assert.equal(forkRequest.config.model_provider, "example_provider");
  assert.deepEqual(forkRequest.config.model_providers.example_provider, {
    name: "Example Provider",
    base_url: "https://example.test/v1",
    wire_api: "responses",
    requires_openai_auth: true,
  });
  assert.equal(forkRequest.approvalPolicy, "never");
  assert.equal(bridge.sessions.getBinding({
    senderId: "ou_allowed",
    chatId: "oc_1",
    repository: "repo",
  }).threadId, "thread-fork");
  assert.match(replies.at(-1).text, /thread-s/);
});

test("fork truncates before the oldest residual in-progress turn", async () => {
  const { bridge, replies } = await fixture();
  bridge.codex.threadOptions = () => ({});
  bridge.catalog = {
    async resolve() {
      return {
        id: "thread-source",
        name: "Source thread",
        status: { type: "idle" },
      };
    },
  };
  let forkRequest;
  bridge.appServer = {
    async listTurns() {
      return {
        data: [
          { id: "turn-later-completed", status: "completed" },
          { id: "turn-residual-newer", status: "inProgress" },
          { id: "turn-middle-interrupted", status: "interrupted" },
          { id: "turn-residual-oldest", status: "inProgress" },
          { id: "turn-safe-cutoff", status: "interrupted" },
          { id: "turn-older", status: "completed" },
        ],
        nextCursor: null,
      };
    },
    async forkThread(request) {
      forkRequest = request;
      return { thread: { id: "thread-safe-fork" } };
    },
  };

  await bridge.forkSession(messageEvent({ message_id: "om_safe_fork" }), "thread-source");

  assert.equal(forkRequest.lastTurnId, "turn-safe-cutoff");
  assert.equal(bridge.sessions.getBinding({
    senderId: "ou_allowed",
    chatId: "oc_1",
    repository: "repo",
  }).threadId, "thread-safe-fork");
  assert.match(replies.at(-1).text, /安全截断/);
});

test("routes each workbench topic to an isolated Codex session", async () => {
  const { bridge, config, replies, runs, sent } = await fixture();
  config.lark.p2pOnly = false;
  config.lark.allowedChats = ["oc_workbench"];
  config.lark.workbenchChats = ["oc_workbench"];
  const roots = new Map([
    ["om_topic_a", null],
    ["om_topic_b", null],
    ["om_reply_a", "om_topic_a"],
    ["om_reply_b", "om_topic_b"],
  ]);
  bridge.lark.getMessageContext = async (messageId) => ({
    messageId,
    chatId: "oc_workbench",
    threadId: roots.get(messageId) ? `omt_${roots.get(messageId)}` : null,
    rootId: roots.get(messageId),
    parentId: roots.get(messageId),
  });
  bridge.codex.run = async (job, options) => {
    runs.push({ job, options });
    return {
      code: 0,
      signal: null,
      threadId: job.contextId === "om_topic_a" ? "thread-a" : "thread-b",
      lastMessage: `完成 ${job.contextId}`,
      errors: [],
      completed: true,
      timedOut: false,
    };
  };

  const groupEvent = (overrides) => messageEvent({
    chat_id: "oc_workbench",
    chat_type: "group",
    ...overrides,
  });
  await bridge.handleEvent(groupEvent({
    event_id: "evt_topic_a",
    message_id: "om_topic_a",
    content: "/start repo 开始 A",
  }));
  await bridge.waitForIdle();
  await bridge.handleEvent(groupEvent({
    event_id: "evt_topic_b",
    message_id: "om_topic_b",
    content: "/start repo 开始 B",
  }));
  await bridge.waitForIdle();
  await bridge.handleEvent(groupEvent({
    event_id: "evt_reply_a",
    message_id: "om_reply_a",
    content: "继续 A",
  }));
  await bridge.waitForIdle();
  await bridge.handleEvent(groupEvent({
    event_id: "evt_reply_b",
    message_id: "om_reply_b",
    content: "继续 B",
  }));
  await bridge.waitForIdle();

  assert.equal(runs.length, 4);
  assert.equal(runs[0].job.contextId, "om_topic_a");
  assert.equal(runs[1].job.contextId, "om_topic_b");
  assert.equal(runs[2].options.resumeThreadId, "thread-a");
  assert.equal(runs[3].options.resumeThreadId, "thread-b");
  assert.equal(bridge.sessions.getBinding({
    senderId: "ou_allowed",
    chatId: "oc_workbench",
    contextId: "om_topic_a",
    repository: "repo",
  }).threadId, "thread-a");
  assert.equal(bridge.sessions.getBinding({
    senderId: "ou_allowed",
    chatId: "oc_workbench",
    contextId: "om_topic_b",
    repository: "repo",
  }).threadId, "thread-b");
  assert.equal(sent.length, 0);
  assert.ok(replies.length >= 8);
  assert.ok(replies.every((reply) => (
    new Set(["om_topic_a", "om_topic_b"]).has(reply.messageId)
      && reply.options?.replyInThread === true
  )));
});

test("fails closed when a workbench message context cannot be resolved", async () => {
  const { bridge, config, replies, runs } = await fixture();
  config.lark.p2pOnly = false;
  config.lark.allowedChats = ["oc_workbench"];
  config.lark.workbenchChats = ["oc_workbench"];
  bridge.lark.getMessageContext = async () => { throw new Error("message lookup unavailable"); };
  const result = await bridge.handleEvent(messageEvent({
    event_id: "evt_context_failure",
    message_id: "om_context_failure",
    chat_id: "oc_workbench",
    chat_type: "group",
    content: "/start repo 不应执行",
  }));

  assert.equal(result.reason, "context_lookup_failed");
  assert.equal(runs.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].messageId, "om_context_failure");
  assert.equal(replies[0].options.replyInThread, true);
  assert.match(replies[0].text, /没有执行/);
});

test("keeps free-form chat disabled in the legacy private conversation", async () => {
  const { bridge, replies, runs } = await fixture();
  await bridge.handleEvent(messageEvent({
    event_id: "evt_private_freeform",
    message_id: "om_private_freeform",
    content: "这不应自动执行",
  }));
  assert.equal(runs.length, 0);
  assert.match(replies[0].text, /只接受以 \/ 开头/);
});

test("claims duplicate deliveries before asynchronous topic lookup", async () => {
  const { bridge, config, replies } = await fixture();
  config.lark.p2pOnly = false;
  config.lark.allowedChats = ["oc_workbench"];
  config.lark.workbenchChats = ["oc_workbench"];
  let releaseLookup;
  bridge.lark.getMessageContext = async (messageId) => {
    await new Promise((resolve) => { releaseLookup = resolve; });
    return { messageId, chatId: "oc_workbench", threadId: null, rootId: null, parentId: null };
  };
  const event = messageEvent({
    event_id: "evt_duplicate_topic",
    message_id: "om_duplicate_topic",
    chat_id: "oc_workbench",
    chat_type: "group",
    content: "/help",
  });

  const firstPromise = bridge.handleEvent(event);
  await waitFor(() => typeof releaseLookup === "function");
  const duplicate = await bridge.handleEvent(event);
  releaseLookup();
  const first = await firstPromise;

  assert.equal(first.accepted, true);
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(replies.length, 1);
});

test("serializes initialization so one topic cannot create two Codex threads", async () => {
  const { bridge, config, runs } = await fixture();
  config.lark.p2pOnly = false;
  config.lark.allowedChats = ["oc_workbench"];
  config.lark.workbenchChats = ["oc_workbench"];
  bridge.lark.getMessageContext = async (messageId) => ({
    messageId,
    chatId: "oc_workbench",
    threadId: "omt_one",
    rootId: messageId === "om_topic_first" ? null : "om_topic_first",
    parentId: messageId === "om_topic_first" ? null : "om_topic_first",
  });
  let finishRun;
  bridge.codex.run = async (job, options) => {
    runs.push({ job, options });
    await new Promise((resolve) => { finishRun = resolve; });
    return {
      code: 0,
      signal: null,
      threadId: "thread-only",
      turnId: "turn-only",
      lastMessage: "完成",
      errors: [],
      completed: true,
      timedOut: false,
    };
  };
  const first = messageEvent({
    event_id: "evt_topic_first",
    message_id: "om_topic_first",
    chat_id: "oc_workbench",
    chat_type: "group",
    content: "/start repo 第一个任务",
  });
  const second = messageEvent({
    event_id: "evt_topic_second",
    message_id: "om_topic_second",
    chat_id: "oc_workbench",
    chat_type: "group",
    content: "/start repo 第二个任务",
  });

  await Promise.all([bridge.handleEvent(first), bridge.handleEvent(second)]);
  await waitFor(() => runs.length === 1 && typeof finishRun === "function");
  finishRun();
  await bridge.waitForIdle();

  assert.equal(runs.length, 1);
  assert.equal(bridge.sessions.getBinding({
    senderId: "ou_allowed",
    chatId: "oc_workbench",
    contextId: "om_topic_first",
    repository: "repo",
  }).threadId, "thread-only");
});

test("walks parent metadata until it finds the canonical topic root", async () => {
  const { bridge, config } = await fixture();
  config.lark.p2pOnly = false;
  config.lark.allowedChats = ["oc_workbench"];
  config.lark.workbenchChats = ["oc_workbench"];
  const contexts = new Map([
    ["om_child", { rootId: null, parentId: "om_parent" }],
    ["om_parent", { rootId: "om_root", parentId: "om_root" }],
  ]);
  bridge.lark.getMessageContext = async (messageId) => ({
    messageId,
    chatId: "oc_workbench",
    threadId: "omt_topic",
    ...contexts.get(messageId),
  });

  const resolved = await bridge.resolveEventContext(messageEvent({
    message_id: "om_child",
    chat_id: "oc_workbench",
    chat_type: "group",
  }));
  assert.equal(resolved.context_id, "om_root");
});

test("strips the leading bot mention before parsing a workbench command", async () => {
  const { bridge, config, runs } = await fixture();
  config.lark.p2pOnly = false;
  config.lark.allowedChats = ["oc_workbench"];
  config.lark.workbenchChats = ["oc_workbench"];
  bridge.lark.getMessageContext = async (messageId) => ({
    messageId,
    chatId: "oc_workbench",
    threadId: "omt_mention",
    rootId: "om_topic_root",
    parentId: "om_topic_root",
    text: "@_user_1 /start repo 提及测试",
    mentionKeys: ["@_user_1"],
  });

  await bridge.handleEvent(messageEvent({
    event_id: "evt_mentioned_start",
    message_id: "om_mentioned_start",
    chat_id: "oc_workbench",
    chat_type: "group",
    content: "@机器人 /start repo 提及测试",
  }));
  await bridge.waitForIdle();

  assert.equal(runs.length, 1);
  assert.equal(runs[0].job.prompt, "提及测试");
  assert.equal(runs[0].job.contextId, "om_topic_root");
});
