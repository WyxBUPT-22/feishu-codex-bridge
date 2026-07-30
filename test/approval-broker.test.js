import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalBroker, PRE_TOOL_APPROVAL_METHOD } from "../src/approval-broker.js";
import { baseConfig } from "./helpers.js";

function fixture({
  approvalMode,
  repositoryPath = "C:\\repo",
  approvalPresenter = null,
  reminderDelayMs = 10_000,
  contextId = undefined,
  lark = null,
} = {}) {
  const messages = [];
  const job = {
    id: "job-1",
    senderId: "ou_1",
    chatId: "oc_1",
    repository: "repo",
    threadId: "thread-1",
    turnId: "turn-1",
    approvalMode,
    ...(contextId ? { contextId } : {}),
  };
  const broker = new ApprovalBroker({
    lark: lark ?? {
      async sendApprovalCard(chatId, card) {
        const messageId = `om_card${messages.length + 1}`;
        messages.push({ chatId, card, text: JSON.stringify(card), messageId });
        return { messageId };
      },
      async sendText(chatId, text) { messages.push({ chatId, text }); },
    },
    config: baseConfig(repositoryPath),
    lookupJob: (threadId, turnId) => (
      threadId === job.threadId && turnId === job.turnId ? job : null
    ),
    timeoutMs: 60_000,
    logger: { info() {}, error() {} },
    approvalPresenter,
    reminderDelayMs,
  });
  broker.setCardActionsAvailable(true);
  return { broker, messages, job };
}

test("places an approval in the task control card before using a standalone card", async () => {
  const presented = [];
  const approvalPresenter = {
    async addApproval(input) {
      presented.push(input);
      return { messageId: "om_control", presentation: "control" };
    },
    async setStats() {},
  };
  const { broker, messages } = fixture({ approvalPresenter });
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "control-tool",
      cwd: "C:\\repo", toolName: "Bash", command: "npm test",
      toolInput: { command: "npm test" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 0);
  assert.equal(presented.length, 1);
  const result = broker.decideCard({
    senderId: "ou_1", chatId: "oc_1", messageId: "om_control",
    actionId: presented[0].actionId, approved: true,
  });
  assert.equal(result.presentation, "control");
  assert.equal(result.card, null);
  assert.deepEqual(await pending, { decision: "accept" });
});

test("sends one delayed app urgent while a shared-card approval remains pending", async () => {
  const presented = [];
  const urgent = [];
  const approvalPresenter = {
    async addApproval(input) {
      presented.push(input);
      return { messageId: "om_control", presentation: "control" };
    },
    async setStats() {},
  };
  const { broker } = fixture({
    approvalPresenter,
    reminderDelayMs: 5,
    lark: {
      async urgentApp(...args) { urgent.push(args); },
      async sendText() { throw new Error("must not use text fallback"); },
    },
  });
  const decision = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "urgent-tool",
      cwd: "C:\\repo", toolName: "Bash", command: "npm test",
      toolInput: { command: "npm test" },
    },
  });
  for (let index = 0; index < 50 && urgent.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(urgent, [["om_control", ["ou_1"]]]);
  assert.equal(broker.decideCard({
    senderId: "ou_1", chatId: "oc_1", messageId: "om_control",
    actionId: presented[0].actionId, approved: true,
  }).ok, true);
  assert.deepEqual(await decision, { decision: "accept" });
  await broker.waitForReminders();
});

test("cancels a delayed reminder when the approval is handled promptly", async () => {
  const presented = [];
  let urgentCount = 0;
  const { broker } = fixture({
    reminderDelayMs: 40,
    approvalPresenter: {
      async addApproval(input) {
        presented.push(input);
        return { messageId: "om_control", presentation: "control" };
      },
      async setStats() {},
    },
    lark: { async urgentApp() { urgentCount += 1; } },
  });
  const decision = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "quick-tool",
      cwd: "C:\\repo", toolName: "Bash", command: "npm test",
      toolInput: { command: "npm test" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.decideCard({
    senderId: "ou_1", chatId: "oc_1", messageId: "om_control",
    actionId: presented[0].actionId, approved: true,
  }).ok, true);
  assert.deepEqual(await decision, { decision: "accept" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(urgentCount, 0);
});

test("falls back to one topic text reminder when app urgent is unavailable", async () => {
  const replies = [];
  const { broker } = fixture({
    contextId: "om_root",
    reminderDelayMs: 0,
    approvalPresenter: {
      async addApproval() {
        return { messageId: "om_control", presentation: "control" };
      },
      async setStats() {},
    },
    lark: {
      async urgentApp() { throw new Error("missing scope"); },
      async sendText() { throw new Error("must not send outside the topic"); },
      async replyText(...args) { replies.push(args); },
    },
  });
  const decision = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "fallback-reminder",
      cwd: "C:\\repo", toolName: "Bash", command: "npm test",
      toolInput: { command: "npm test" },
    },
  });
  for (let index = 0; index < 50 && replies.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], "om_root");
  assert.match(replies[0][1], /Codex 待审批/);
  assert.deepEqual(replies[0][3], { replyInThread: true });
  assert.equal(broker.pending.size, 1);
  broker.declineAll("test");
  assert.deepEqual(await decision, { decision: "decline" });
  await broker.waitForReminders();
});

test("falls back to the standalone approval card when control-card PATCH fails", async () => {
  const { broker, messages } = fixture({
    approvalPresenter: {
      async addApproval() { return null; },
      async setStats() {},
    },
  });
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "fallback-tool",
      cwd: "C:\\repo", toolName: "Bash", command: "npm test",
      toolInput: { command: "npm test" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, "om_card1");
  broker.declineAll("test");
  assert.deepEqual(await pending, { decision: "decline" });
});

test("passes the timeout reason to the shared control card", async () => {
  const settlements = [];
  const presented = [];
  const { broker } = fixture({
    approvalPresenter: {
      async addApproval(input) {
        presented.push(input);
        return { messageId: "om_control", presentation: "control" };
      },
      async setStats() {},
      async settleApproval(...args) { settlements.push(args); },
    },
  });
  const decision = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "timeout-tool",
      cwd: "C:\\repo", toolName: "Bash", command: "npm test",
      toolInput: { command: "npm test" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const code = [...broker.pending.keys()][0];
  broker.settle(code, false, "timeout");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settlements, [["job-1", presented[0].actionId, false, "timeout"]]);
  assert.deepEqual(await decision, { decision: "decline" });
});

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-broker-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.js"), "old\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function cardAction(message, decision) {
  const actionRow = message.card.elements.find((element) => element.tag === "action");
  return actionRow.actions.find((button) => button.value.decision === decision).value;
}

function shlexQuote(value) {
  if (value.length === 0) return "''";
  const unquoted = (character) => /[+\-./:@\]_0-9A-Za-z]/.test(character);
  const output = [];
  let offset = 0;
  while (offset < value.length) {
    let allowed = 1 | 2 | 4;
    let end = offset;
    if (value[end] === "^") {
      allowed = 2;
      end += 1;
    }
    while (end < value.length) {
      const codePoint = value.codePointAt(end);
      const width = codePoint > 0xffff ? 2 : 1;
      const character = value.slice(end, end + width);
      let current = allowed;
      if (codePoint >= 0x80) current &= ~1;
      else {
        if (!unquoted(character)) current &= ~1;
        if (["'", "^", "\\"].includes(character)) current &= ~2;
        if (["`", "$", "!", "^"].includes(character)) current &= ~4;
      }
      if (current === 0) break;
      allowed = current;
      end += width;
    }
    const chunk = value.slice(offset, end);
    if ((allowed & 1) !== 0) output.push(chunk);
    else if ((allowed & 2) !== 0) output.push(`'${chunk}'`);
    else output.push(`"${chunk.replace(/[$`"\\]/g, "\\$&")}"`);
    offset = end;
  }
  return output.join("");
}

function shlexJoin(words) {
  return words.map(shlexQuote).join(" ");
}

function nativePowerShellCommand(command, {
  executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  args = ["-NoProfile", "-Command"],
  trailing = [],
} = {}) {
  return shlexJoin([executable, ...args, command, ...trailing]);
}

test("requires one-time confirmation even for classified read-only commands", async () => {
  const { broker, messages } = fixture();
  const pending = broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-read",
      cwd: "C:\\repo",
      command: "rg x",
      commandActions: [{ type: "search", command: "rg x", path: null }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  broker.declineAll("test");
  assert.deepEqual(await pending, { decision: "decline" });
});

test("requires one-time confirmation for a sandbox-preserving pre-tool hook", async () => {
  const { broker, messages } = fixture();
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-1",
      cwd: "C:\\repo",
      toolName: "Bash",
      command: "Get-Content package.json",
      toolInput: { command: "Get-Content package.json", sandbox_permissions: "use_default" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  assert.equal(broker.decide({ senderId: "ou_1", chatId: "oc_1", code, approved: true }).ok, true);
  assert.deepEqual(await pending, { decision: "accept" });
});

test("defaults old jobs to strict while balanced and auto pass shell hooks to native policy", async () => {
  const strict = fixture();
  const strictPending = strict.broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "strict-shell",
      cwd: "C:\\repo", toolName: "Bash", command: "Get-Content package.json",
      toolInput: { command: "Get-Content package.json" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(strict.messages.length, 1);
  assert.deepEqual(strict.broker.takeJobStats("job-1"), { automatic: 0, manual: 1 });
  strict.broker.declineAll("test");
  assert.deepEqual(await strictPending, { decision: "decline" });

  for (const approvalMode of ["balanced", "auto"]) {
    const { broker, messages } = fixture({ approvalMode });
    assert.deepEqual(await broker.handle({
      method: PRE_TOOL_APPROVAL_METHOD,
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: `${approvalMode}-shell`,
        cwd: "C:\\repo", toolName: "Bash", command: "Remove-Item package.json",
        toolInput: { command: "Remove-Item package.json" },
      },
    }), { decision: "accept" });
    assert.equal(messages.length, 0);
    assert.equal(broker.linkedApprovals.size, 0);
    assert.deepEqual(broker.takeJobStats("job-1"), { automatic: 1, manual: 0 });
    assert.deepEqual(broker.takeJobStats("job-1"), { automatic: 0, manual: 0 });
  }
});

test("requires one unambiguous shell input equal to the canonical command", async () => {
  for (const toolInput of [
    { command: "Get-Content package.json", cmd: "Get-Content package.json" },
    { command: "Get-Content other.json" },
    { cmd: "Get-Content other.json" },
    {},
    [],
  ]) {
    const { broker, messages } = fixture({ approvalMode: "balanced" });
    assert.deepEqual(await broker.handle({
      method: PRE_TOOL_APPROVAL_METHOD,
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "ambiguous-shell",
        cwd: "C:\\repo", toolName: "Bash", command: "Get-Content package.json", toolInput,
      },
    }), { decision: "decline" });
    assert.equal(messages.length, 0);
    assert.deepEqual(broker.takeJobStats("job-1"), { automatic: 0, manual: 0 });
  }

  const { broker } = fixture({ approvalMode: "balanced" });
  assert.deepEqual(await broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "canonical-cmd",
      cwd: "C:\\repo", toolName: "shell", command: "Get-Content package.json",
      toolInput: { cmd: "Get-Content package.json" },
    },
  }), { decision: "accept" });
});

test("hard-denies permission expansion and ambiguous aliases in every mode", async () => {
  for (const approvalMode of [undefined, "balanced", "auto"]) {
    for (const permissions of [
      { sandbox_permissions: "require_escalated" },
      { sandboxPermissions: "require_escalated" },
      { sandbox_permissions: null },
      { sandbox_permissions: "use_default", sandboxPermissions: "require_escalated" },
      { sandbox_permissions: "use_default", sandboxPermissions: "use_default" },
      { additional_permissions: { fileSystem: ["C:\\outside"] } },
      { additional_permissions: null, additionalPermissions: null },
      { network_access: true },
      { network_access: false, networkAccess: false },
    ]) {
      const { broker, messages } = fixture({ approvalMode });
      assert.deepEqual(await broker.handle({
        method: PRE_TOOL_APPROVAL_METHOD,
        params: {
          threadId: "thread-1", turnId: "turn-1", itemId: "permission-expansion",
          cwd: "C:\\repo", toolName: "Bash", command: "Get-Content package.json",
          toolInput: { command: "Get-Content package.json", ...permissions },
        },
      }), { decision: "decline" });
      assert.equal(messages.length, 0, approvalMode ?? "strict");
      assert.deepEqual(broker.takeJobStats("job-1"), { automatic: 0, manual: 0 });
    }
  }
});

test("hard-denies shell working directories outside the repository", async (t) => {
  for (const approvalMode of [undefined, "balanced", "auto"]) {
    for (const directoryInput of [
      { workdir: "C:\\outside" },
      { cwd: "C:\\outside" },
      { workdir: "C:\\repo", cwd: "C:\\repo" },
      { workdir: 42 },
    ]) {
      const { broker, messages } = fixture({ approvalMode });
      assert.deepEqual(await broker.handle({
        method: PRE_TOOL_APPROVAL_METHOD,
        params: {
          threadId: "thread-1", turnId: "turn-1", itemId: "outside-workdir",
          cwd: "C:\\repo", toolName: "shell_command", command: "Get-Content secret.txt",
          toolInput: { command: "Get-Content secret.txt", ...directoryInput },
        },
      }), { decision: "decline" });
      assert.equal(messages.length, 0, approvalMode ?? "strict");
      assert.deepEqual(broker.takeJobStats("job-1"), { automatic: 0, manual: 0 });
    }
  }

  const root = await repository(t);
  for (const directoryInput of [{ workdir: "src" }, { cwd: path.join(root, "src") }]) {
    const { broker, messages } = fixture({ approvalMode: "balanced", repositoryPath: root });
    assert.deepEqual(await broker.handle({
      method: PRE_TOOL_APPROVAL_METHOD,
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "inside-workdir",
        cwd: root, toolName: "shell_command", command: "Get-Content file.txt",
        toolInput: { command: "Get-Content file.txt", ...directoryInput },
      },
    }), { decision: "accept" });
    assert.equal(messages.length, 0);
  }

  const outside = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-broker-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const linked = path.join(root, "linked-outside");
  try {
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    return;
  }
  const linkedFixture = fixture({ approvalMode: "balanced", repositoryPath: root });
  assert.deepEqual(await linkedFixture.broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "linked-workdir",
      cwd: root, toolName: "shell_command", command: "Get-Content secret.txt",
      toolInput: { command: "Get-Content secret.txt", workdir: linked },
    },
  }), { decision: "decline" });
  assert.equal(linkedFixture.messages.length, 0);
});

test("keeps every unlinked native command approval manual in every mode", async () => {
  for (const approvalMode of [undefined, "balanced", "auto"]) {
    const { broker, messages } = fixture({ approvalMode });
    const pending = broker.handle({
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "native-command",
        cwd: "C:\\repo", command: "rg x",
        commandActions: [{ type: "search", command: "rg x", path: null }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1, approvalMode ?? "strict");
    assert.deepEqual(broker.takeJobStats("job-1"), { automatic: 0, manual: 1 });
    broker.declineAll("test");
    assert.deepEqual(await pending, { decision: "decline" });
  }
});

test("uses patch risk to separate strict, balanced, auto, and hard-deny behavior", async (t) => {
  const root = await repository(t);
  const updatePatch = [
    "*** Begin Patch",
    "*** Update File: src/main.js",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
  const deletePatch = [
    "*** Begin Patch",
    "*** Delete File: src/main.js",
    "*** End Patch",
  ].join("\n");
  const hookParams = (itemId, patch) => ({
    threadId: "thread-1", turnId: "turn-1", itemId,
    cwd: root, toolName: "apply_patch", toolInput: { command: patch },
  });

  const strict = fixture({ repositoryPath: root });
  const strictPending = strict.broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: hookParams("strict-update", updatePatch),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(strict.messages.length, 1);
  assert.deepEqual(strict.broker.takeJobStats("job-1"), { automatic: 0, manual: 1 });
  strict.broker.declineAll("test");
  await strictPending;

  const balanced = fixture({ approvalMode: "balanced", repositoryPath: root });
  assert.deepEqual(await balanced.broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: hookParams("balanced-update", updatePatch),
  }), { decision: "accept" });
  assert.equal(balanced.messages.length, 0);
  assert.equal(balanced.broker.linkedApprovals.size, 1);
  assert.deepEqual(await balanced.broker.handle({
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "balanced-update", cwd: root,
    },
  }), { decision: "accept" });
  assert.deepEqual(await balanced.broker.handle({
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "balanced-update", cwd: root,
    },
  }), { decision: "decline" });
  assert.deepEqual(balanced.broker.takeJobStats("job-1"), { automatic: 1, manual: 0 });

  const balancedDestructive = fixture({ approvalMode: "balanced", repositoryPath: root });
  const destructivePending = balancedDestructive.broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: hookParams("balanced-delete", deletePatch),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(balancedDestructive.messages.length, 1);
  assert.deepEqual(
    balancedDestructive.broker.takeJobStats("job-1"),
    { automatic: 0, manual: 1 },
  );
  balancedDestructive.broker.declineAll("test");
  await destructivePending;

  const automatic = fixture({ approvalMode: "auto", repositoryPath: root });
  assert.deepEqual(await automatic.broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: hookParams("auto-delete", deletePatch),
  }), { decision: "accept" });
  assert.equal(automatic.messages.length, 0);
  assert.equal(automatic.broker.linkedApprovals.size, 1);
  assert.deepEqual(automatic.broker.takeJobStats("job-1"), { automatic: 1, manual: 0 });
  automatic.broker.declineAll("test");

  for (const approvalMode of [undefined, "balanced", "auto"]) {
    const denied = fixture({ approvalMode, repositoryPath: root });
    assert.deepEqual(await denied.broker.handle({
      method: PRE_TOOL_APPROVAL_METHOD,
      params: hookParams(
        `denied-${approvalMode ?? "strict"}`,
        "*** Begin Patch\n*** Add File: ../outside.js\n+x\n*** End Patch",
      ),
    }), { decision: "decline" });
    assert.equal(denied.messages.length, 0);
    assert.deepEqual(denied.broker.takeJobStats("job-1"), { automatic: 0, manual: 0 });
  }
});

test("deduplicates job stats and replaces a provisional shell auto count with native manual", async () => {
  const { broker, messages } = fixture({ approvalMode: "balanced" });
  const params = {
    threadId: "thread-1", turnId: "turn-1", itemId: "same-item",
    cwd: "C:\\repo", toolName: "Bash", command: "npm test",
    toolInput: { command: "npm test" },
  };
  assert.deepEqual(await broker.handle({ method: PRE_TOOL_APPROVAL_METHOD, params }), {
    decision: "accept",
  });
  assert.deepEqual(await broker.handle({ method: PRE_TOOL_APPROVAL_METHOD, params }), {
    decision: "accept",
  });
  assert.equal(broker.linkedApprovals.size, 0);

  const pending = broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "same-item",
      cwd: "C:\\repo", command: "npm test",
      commandActions: [{ type: "unknown", command: "npm test" }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.deepEqual(broker.takeJobStats("job-1"), { automatic: 0, manual: 1 });
  assert.deepEqual(broker.takeJobStats("job-1"), { automatic: 0, manual: 0 });
  broker.declineAll("test");
  await pending;
});

test("approves from a card only when actor, chat, message and action id all match", async () => {
  const { broker, messages } = fixture();
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "tool-card",
      cwd: "C:\\repo", toolName: "Bash", command: "npm test",
      toolInput: { command: "npm test" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const action = cardAction(messages[0], "approve");
  assert.equal(action.actionId.length, 32);
  assert.equal(messages[0].card.config.enable_forward, false);

  assert.equal(broker.decideCard({
    senderId: "ou_other", chatId: "oc_1", messageId: messages[0].messageId,
    actionId: action.actionId, approved: true,
  }).reason, "forbidden");
  assert.equal(broker.decideCard({
    senderId: "ou_1", chatId: "oc_1", messageId: "om_wrong",
    actionId: action.actionId, approved: true,
  }).reason, "forbidden");
  const approved = broker.decideCard({
    senderId: "ou_1", chatId: "oc_1", messageId: messages[0].messageId,
    actionId: action.actionId, approved: true,
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.card.header.template, "green");
  assert.equal(approved.card.header.title.content, "Codex 操作已批准");
  assert.equal(approved.card.elements.some((element) => element.tag === "action"), false);
  assert.deepEqual(await pending, { decision: "accept" });
  assert.equal(broker.decideCard({
    senderId: "ou_1", chatId: "oc_1", messageId: messages[0].messageId,
    actionId: action.actionId, approved: false,
  }).reason, "missing");
});

test("a card-approved hook links to Codex's shlex-joined PowerShell approval once", async () => {
  const { broker, messages } = fixture();
  const command = "$logs = Get-ChildItem -LiteralPath \"$env:LOCALAPPDATA\\bridge\\logs\" | "
    + "Select-Object -First 1; Select-String -LiteralPath 'C:\\repo\\bridge.log' -Pattern 'error'";
  const hook = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-card-native",
      cwd: "C:\\repo", toolName: "Bash", command,
      toolInput: { command },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const action = cardAction(messages[0], "approve");
  assert.equal(broker.decideCard({
    senderId: "ou_1", chatId: "oc_1", messageId: messages[0].messageId,
    actionId: action.actionId, approved: true,
  }).ok, true);
  assert.deepEqual(await hook, { decision: "accept" });

  const nativeCommand = nativePowerShellCommand(command);
  assert.match(nativeCommand, /-NoProfile -Command/);
  assert.match(nativeCommand, /\\\\Windows/);
  assert.deepEqual(await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-card-native",
      cwd: "C:\\repo", command: nativeCommand,
      commandActions: [{ type: "search", command, path: "C:\\repo\\bridge.log" }],
      availableDecisions: ["accept", "acceptForSession", "decline"],
    },
  }), { decision: "accept" });
  assert.equal(messages.length, 1);

  const replay = broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-card-native",
      cwd: "C:\\repo", command: nativeCommand, commandActions: [],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 2);
  broker.declineAll("test");
  assert.deepEqual(await replay, { decision: "decline" });
});

test("declines a shlex-joined PowerShell wrapper whose payload or flags changed", async () => {
  for (const nativeCommand of [
    nativePowerShellCommand("Get-Content package.json; Remove-Item package.json"),
    nativePowerShellCommand("Get-Content package.json", { args: ["-NoExit", "-Command"] }),
    nativePowerShellCommand("Get-Content package.json", { args: ["-Command"] }),
    nativePowerShellCommand("Get-Content package.json", { args: ["-EncodedCommand"] }),
    nativePowerShellCommand("Get-Content package.json", {
      executable: "C:\\repo\\powershell.exe",
    }),
    nativePowerShellCommand("Get-Content package.json", { trailing: [""] }),
    `${nativePowerShellCommand("Get-Content package.json")} `,
    nativePowerShellCommand("Get-Content package.json").replace(" -NoProfile", "  -NoProfile"),
    '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -NoProfile -Command \'Get-Content package.json',
  ]) {
    const { broker, messages } = fixture();
    const command = "Get-Content package.json";
    const hook = broker.handle({
      method: PRE_TOOL_APPROVAL_METHOD,
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "exec-wrapper-mismatch",
        cwd: "C:\\repo", toolName: "Bash", command, toolInput: { command },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const action = cardAction(messages[0], "approve");
    broker.decideCard({
      senderId: "ou_1", chatId: "oc_1", messageId: messages[0].messageId,
      actionId: action.actionId, approved: true,
    });
    await hook;
    assert.deepEqual(await broker.handle({
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "exec-wrapper-mismatch",
        cwd: "C:\\repo", command: nativeCommand,
        commandActions: [{ type: "read", command, path: "C:\\repo\\package.json" }],
      },
    }), { decision: "decline" });
    assert.equal(messages.length, 1);
  }
});

test("rejects an approval card action after its explicit expiry", async () => {
  const { broker, messages } = fixture();
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "tool-expired",
      cwd: "C:\\repo", toolName: "Bash", command: "npm test",
      toolInput: { command: "npm test" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const action = cardAction(messages[0], "approve");
  const result = broker.decideCard({
    senderId: "ou_1", chatId: "oc_1", messageId: messages[0].messageId,
    actionId: action.actionId, approved: true, now: Date.now() + 120_000,
  });
  assert.equal(result.reason, "missing");
  assert.deepEqual(await pending, { decision: "decline" });
});

test("rejects a text approval after its explicit expiry even before the timer runs", async () => {
  const { broker, messages } = fixture();
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "tool-text-expired",
      cwd: "C:\\repo", toolName: "Bash", command: "npm test",
      toolInput: { command: "npm test" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  const result = broker.decide({
    senderId: "ou_1", chatId: "oc_1", code, approved: true,
    now: Date.now() + 120_000,
  });
  assert.equal(result.reason, "missing");
  assert.deepEqual(await pending, { decision: "decline" });
});

test("falls back to text approval when card delivery cannot be bound to a message", async () => {
  const messages = [];
  const job = {
    id: "job-1", senderId: "ou_1", chatId: "oc_1", repository: "repo",
    threadId: "thread-1", turnId: "turn-1",
  };
  const broker = new ApprovalBroker({
    lark: {
      async sendApprovalCard() { return {}; },
      async sendText(chatId, text) { messages.push({ chatId, text }); },
    },
    config: baseConfig("C:\\repo"),
    lookupJob: (threadId, turnId) => (
      threadId === job.threadId && turnId === job.turnId ? job : null
    ),
    timeoutMs: 60_000,
    logger: { info() {}, error() {} },
  });
  broker.setCardActionsAvailable(true);
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "tool-fallback",
      cwd: "C:\\repo", toolName: "Bash", command: "npm test",
      toolInput: { command: "npm test" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  assert.equal(broker.pendingActions.size, 0);
  assert.equal(broker.decide({ senderId: "ou_1", chatId: "oc_1", code, approved: true }).ok, true);
  assert.deepEqual(await pending, { decision: "accept" });
});

test("shows and validates apply_patch targets before prompting", async (t) => {
  const root = await repository(t);
  const { broker, messages } = fixture({ repositoryPath: root });
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-patch",
      cwd: root,
      toolName: "apply_patch",
      toolInput: {
        command: "*** Begin Patch\n*** Update File: src/main.js\n@@\n-old\n+new\n*** End Patch",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /src\/main\.js/);
  broker.declineAll("test");
  assert.deepEqual(await pending, { decision: "decline" });

  assert.deepEqual(await broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "C:\\repo",
      toolName: "apply_patch",
      toolInput: { command: "*** Begin Patch\n*** Update File: C:\\outside.txt\n*** End Patch" },
    },
  }), { decision: "decline" });
  assert.equal(messages.length, 1);
});

test("links an approved hook to the exact native command approval once", async () => {
  const { broker, messages } = fixture();
  const hook = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "exec-1",
      cwd: "C:\\repo",
      toolName: "Bash",
      command: "node --version",
      toolInput: { command: "node --version" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  broker.decide({ senderId: "ou_1", chatId: "oc_1", code, approved: true });
  assert.deepEqual(await hook, { decision: "accept" });

  assert.deepEqual(await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "exec-1",
      cwd: "C:\\repo",
      command: nativePowerShellCommand("node --version"),
      commandActions: [{ type: "unknown", command: "node --version" }],
      proposedExecpolicyAmendment: ["node"],
      availableDecisions: ["accept", "acceptForSession", "decline"],
    },
  }), { decision: "accept" });
  assert.equal(messages.length, 1);

  const second = broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-1",
      cwd: "C:\\repo", command: "node --version", commandActions: [],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 2);
  broker.declineAll("test");
  assert.deepEqual(await second, { decision: "decline" });
});

test("declines a linked native approval whose command payload changed", async () => {
  const { broker, messages } = fixture();
  const hook = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-mismatch",
      cwd: "C:\\repo", toolName: "Bash", command: "node --version",
      toolInput: { command: "node --version" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  broker.decide({ senderId: "ou_1", chatId: "oc_1", code, approved: true });
  await hook;

  assert.deepEqual(await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-mismatch",
      cwd: "C:\\repo",
      command: 'Write-Output evil; "powershell.exe" -Command "node --version"',
      commandActions: [{ type: "unknown", command: "node --version" }],
    },
  }), { decision: "decline" });
  assert.equal(messages.length, 1);
  assert.equal(broker.linkedApprovals.size, 0);
});

test("does not collapse command whitespace when linking approvals", async () => {
  const { broker, messages } = fixture();
  const hook = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-whitespace",
      cwd: "C:\\repo", toolName: "Bash", command: "echo alpha  beta",
      toolInput: { command: "echo alpha  beta" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  broker.decide({ senderId: "ou_1", chatId: "oc_1", code, approved: true });
  await hook;
  assert.deepEqual(await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-whitespace",
      cwd: "C:\\repo", command: "echo alpha beta", commandActions: [],
    },
  }), { decision: "decline" });
});

test("links a verified apply_patch hook only to its exact native file approval", async (t) => {
  const root = await repository(t);
  const { broker, messages } = fixture({ repositoryPath: root });
  const hook = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-1",
      cwd: root,
      toolName: "apply_patch",
      toolInput: {
        command: "*** Begin Patch\n*** Update File: src/main.js\n*** End Patch",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  broker.decide({ senderId: "ou_1", chatId: "oc_1", code, approved: true });
  assert.deepEqual(await hook, { decision: "accept" });

  assert.deepEqual(await broker.handle({
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "wrong-patch", cwd: root,
    },
  }), { decision: "decline" });
  assert.deepEqual(await broker.handle({
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "patch-1", cwd: root,
    },
  }), { decision: "accept" });
  assert.equal(messages.length, 1);
});

test("does not consume a linked approval for an actual permission expansion", async () => {
  const { broker, messages } = fixture();
  const hook = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-permissions",
      cwd: "C:\\repo", toolName: "Bash", command: "node --version",
      toolInput: { command: "node --version" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  broker.decide({ senderId: "ou_1", chatId: "oc_1", code, approved: true });
  await hook;
  const base = {
    threadId: "thread-1", turnId: "turn-1", itemId: "exec-permissions",
    cwd: "C:\\repo", command: "node --version", commandActions: [],
  };
  assert.deepEqual(await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      ...base,
      additionalPermissions: { network: { enabled: true }, fileSystem: null },
    },
  }), { decision: "decline" });
  assert.deepEqual(await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: { ...base, additionalPermissions: { network: null, fileSystem: null } },
  }), { decision: "accept" });
});

test("does not consume a linked approval for a native action outside the repository", async () => {
  const { broker, messages } = fixture();
  const hook = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-outside",
      cwd: "C:\\repo", toolName: "Bash", command: "Get-Content C:\\repo\\file.txt",
      toolInput: { command: "Get-Content C:\\repo\\file.txt" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  broker.decide({ senderId: "ou_1", chatId: "oc_1", code, approved: true });
  await hook;
  const base = {
    threadId: "thread-1", turnId: "turn-1", itemId: "exec-outside",
    cwd: "C:\\repo", command: "Get-Content C:\\repo\\file.txt",
  };
  assert.deepEqual(await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      ...base,
      commandActions: [{
        type: "read", command: "Get-Content C:\\repo\\file.txt",
        name: "secret.txt", path: "C:\\outside\\secret.txt",
      }],
    },
  }), { decision: "decline" });
  assert.deepEqual(await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: { ...base, commandActions: [] },
  }), { decision: "accept" });
});

test("clears unused linked approvals when a turn ends", async () => {
  const { broker, messages } = fixture();
  const hook = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-clear", cwd: "C:\\repo",
      toolName: "Bash", command: "node --version", toolInput: { command: "node --version" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  broker.decide({ senderId: "ou_1", chatId: "oc_1", code, approved: true });
  await hook;
  broker.declineForTurn("thread-1", "turn-1", "ended");
  assert.deepEqual(await broker.handle({
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-clear", cwd: "C:\\repo",
    },
  }), { decision: "decline" });
});

test("declines pre-tool hooks that request expansion or unsupported tools", async () => {
  const { broker, messages } = fixture();
  for (const params of [
    {
      threadId: "thread-1", turnId: "turn-1", cwd: "C:\\repo", toolName: "Bash",
      command: "Get-Content package.json",
      toolInput: { command: "Get-Content package.json", sandbox_permissions: "require_escalated" },
    },
    {
      threadId: "thread-1", turnId: "turn-1", cwd: "C:\\repo", toolName: "browser",
      command: "open page", toolInput: { command: "open page" },
    },
  ]) {
    assert.deepEqual(await broker.handle({ method: PRE_TOOL_APPROVAL_METHOD, params }), {
      decision: "decline",
    });
  }
  assert.equal(messages.length, 0);
});

test("accepts every supported shell alias emitted by the PreToolUse hook", async () => {
  for (const toolName of ["Bash", "bash", "exec_command", "shell", "shell_command", "unified_exec"]) {
    const { broker, messages } = fixture();
    const pending = broker.handle({
      method: PRE_TOOL_APPROVAL_METHOD,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: `tool-${toolName}`,
        cwd: "C:\\repo",
        toolName,
        command: "Get-Content package.json",
        toolInput: { command: "Get-Content package.json" },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1, toolName);
    broker.declineAll("test");
    assert.deepEqual(await pending, { decision: "decline" });
  }
});

test("declines a declared command action path outside the repository", async () => {
  const { broker, messages } = fixture();
  const result = await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-read",
      cwd: "C:\\repo",
      command: "type C:\\secret.txt",
      commandActions: [{ type: "read", command: "type", name: "secret.txt", path: "C:\\secret.txt" }],
    },
  });
  assert.equal(messages.length, 0);
  assert.deepEqual(result, { decision: "decline" });
});

test("requires a scoped one-time confirmation for unknown commands", async () => {
  const { broker, messages } = fixture();
  const response = broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      cwd: "C:\\repo",
      command: "npm test",
      commandActions: [{ type: "unknown", command: "npm test" }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  assert.equal(broker.decide({ senderId: "ou_other", chatId: "oc_1", code, approved: true }).reason, "forbidden");
  assert.equal(broker.decide({ senderId: "ou_1", chatId: "oc_1", code, approved: true }).ok, true);
  assert.deepEqual(await response, { decision: "accept" });
});

test("declines permission expansion without prompting", async () => {
  const { broker, messages } = fixture();
  const result = await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "C:\\repo",
      command: "curl example",
      additionalPermissions: { network: { enabled: true } },
    },
  });
  assert.deepEqual(result, { decision: "decline" });
  assert.equal(messages.length, 0);
});

test("declines commands outside the selected repository", async () => {
  const { broker } = fixture();
  assert.deepEqual(await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", cwd: "C:\\other", command: "dir" },
  }), { decision: "decline" });
});

test("declines requests without an exact non-empty thread and turn", async () => {
  const { broker, messages } = fixture();
  for (const params of [
    { cwd: "C:\\repo", command: "dir" },
    { threadId: "thread-1", turnId: "", cwd: "C:\\repo", command: "dir" },
    { threadId: "", turnId: "turn-1", cwd: "C:\\repo", command: "dir" },
    { threadId: "thread-1", turnId: "desktop-turn", cwd: "C:\\repo", command: "dir" },
  ]) {
    assert.deepEqual(await broker.handle({
      method: "item/commandExecution/requestApproval",
      params,
    }), { decision: "decline" });
  }
  assert.equal(messages.length, 0);
});

test("declines v2 file-change approvals because they have no verifiable paths", async () => {
  const { broker, messages } = fixture();
  assert.deepEqual(await broker.handle({
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-file",
      cwd: "C:\\repo",
      reason: "edit files",
    },
  }), { decision: "decline" });
  assert.equal(messages.length, 0);
});

test("declines pending approvals by job or exact turn", async () => {
  const messages = [];
  const jobs = new Map([
    ["thread-1:turn-1", { id: "job-1", senderId: "ou_1", chatId: "oc_1", repository: "repo" }],
    ["thread-2:turn-2", { id: "job-2", senderId: "ou_2", chatId: "oc_2", repository: "repo" }],
  ]);
  const broker = new ApprovalBroker({
    lark: { async sendText(chatId, text) { messages.push({ chatId, text }); } },
    config: baseConfig("C:\\repo"),
    lookupJob: (threadId, turnId) => jobs.get(`${threadId}:${turnId}`) ?? null,
    timeoutMs: 60_000,
    logger: { info() {}, error() {} },
  });
  const first = broker.handle({
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", cwd: "C:\\repo" },
  });
  const second = broker.handle({
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-2", turnId: "turn-2", itemId: "item-2", cwd: "C:\\repo" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 2);
  assert.equal(broker.declineForJob("job-1", "cancelled"), 1);
  assert.deepEqual(await first, { decision: "decline" });
  assert.equal(broker.pending.size, 1);
  assert.equal(broker.declineForTurn("thread-2", "wrong-turn", "takeover"), 0);
  assert.equal(broker.declineForTurn("thread-2", "turn-2", "takeover"), 1);
  assert.deepEqual(await second, { decision: "decline" });
  assert.equal(broker.pending.size, 0);
});

test("delivers approval cards inside the job topic", async () => {
  const messages = [];
  const job = {
    id: "job-topic", senderId: "ou_1", chatId: "oc_1", contextId: "om_root",
    repository: "repo", threadId: "thread-topic", turnId: "turn-topic",
  };
  const broker = new ApprovalBroker({
    lark: {
      async sendApprovalCard() { throw new Error("must not send to main"); },
      async replyApprovalCard(messageId, card, key, options) {
        messages.push({ messageId, card, key, options, deliveredId: "om_card_topic" });
        return { messageId: "om_card_topic" };
      },
    },
    config: baseConfig("C:\\repo"),
    lookupJob: (threadId, turnId) => (
      threadId === job.threadId && turnId === job.turnId ? job : null
    ),
    timeoutMs: 60_000,
    logger: { info() {}, error() {} },
  });
  broker.setCardActionsAvailable(true);
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: job.threadId, turnId: job.turnId, itemId: "topic-card",
      cwd: "C:\\repo", toolName: "Bash", command: "Get-Content package.json",
      toolInput: { command: "Get-Content package.json" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, "om_root");
  assert.deepEqual(messages[0].options, { replyInThread: true });
  const action = cardAction({ card: messages[0].card }, "approve");
  assert.equal(broker.decideCard({
    senderId: job.senderId,
    chatId: job.chatId,
    messageId: "om_card_topic",
    actionId: action.actionId,
    approved: true,
  }).ok, true);
  assert.deepEqual(await pending, { decision: "accept" });
});

test("keeps approval fallback text inside the topic", async () => {
  const replies = [];
  let mainSends = 0;
  const job = {
    id: "job-topic", senderId: "ou_1", chatId: "oc_1", contextId: "om_root",
    repository: "repo", threadId: "thread-topic", turnId: "turn-topic",
  };
  const broker = new ApprovalBroker({
    lark: {
      async sendText() { mainSends += 1; },
      async sendApprovalCard() { mainSends += 1; },
      async replyApprovalCard() { throw new Error("card reply failed"); },
      async replyText(...args) { replies.push(args); },
    },
    config: baseConfig("C:\\repo"),
    lookupJob: (threadId, turnId) => (
      threadId === job.threadId && turnId === job.turnId ? job : null
    ),
    timeoutMs: 60_000,
    logger: { info() {}, error() {} },
  });
  broker.setCardActionsAvailable(true);
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: job.threadId, turnId: job.turnId, itemId: "topic-fallback",
      cwd: "C:\\repo", toolName: "Bash", command: "Get-Content package.json",
      toolInput: { command: "Get-Content package.json" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mainSends, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], "om_root");
  assert.deepEqual(replies[0][3], { replyInThread: true });
  broker.declineAll("test");
  assert.deepEqual(await pending, { decision: "decline" });
});

test("optionally checks the topic when approving by confirmation code", async () => {
  const messages = [];
  const job = {
    id: "job-topic", senderId: "ou_1", chatId: "oc_1", contextId: "om_root",
    repository: "repo", threadId: "thread-topic", turnId: "turn-topic",
  };
  const broker = new ApprovalBroker({
    lark: {
      async replyText(messageId, text) { messages.push({ messageId, text }); },
    },
    config: baseConfig("C:\\repo"),
    lookupJob: (threadId, turnId) => (
      threadId === job.threadId && turnId === job.turnId ? job : null
    ),
    timeoutMs: 60_000,
    logger: { info() {}, error() {} },
  });
  const pending = broker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: job.threadId, turnId: job.turnId, itemId: "topic-text",
      cwd: "C:\\repo", toolName: "Bash", command: "Get-Content package.json",
      toolInput: { command: "Get-Content package.json" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const code = /\/approve ([a-f0-9]{6})/.exec(messages[0].text)[1];
  assert.equal(broker.decide({
    senderId: job.senderId, chatId: job.chatId, contextId: "om_other",
    code, approved: true,
  }).reason, "forbidden");
  assert.equal(broker.decide({
    senderId: job.senderId, chatId: job.chatId, contextId: "om_root",
    code, approved: true,
  }).ok, true);
  assert.deepEqual(await pending, { decision: "accept" });
});
