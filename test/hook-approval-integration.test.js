import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ApprovalBroker } from "../src/approval-broker.js";
import { handleHookApproval } from "../src/hook-approval-handler.js";
import { HookApprovalServer } from "../src/hook-approval-server.js";
import { baseConfig } from "./helpers.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.resolve(testDirectory, "../src/pre-tool-approval-hook.mjs");

function runHook(request, endpoint) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath, endpoint], {
      cwd: path.resolve(testDirectory, ".."),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("approval integration hook timed out"));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`hook exited ${code}: ${stderr}`));
      resolve(JSON.parse(stdout.trim()));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

test("one hook approval exactly links to the following native command approval", async (t) => {
  const repositoryPath = path.resolve(testDirectory, "..");
  const messages = [];
  const job = {
    id: "job-1",
    senderId: "ou_1",
    chatId: "oc_1",
    repository: "repo",
  };
  let broker;
  const lark = {
    async sendApprovalCard(chatId, card) {
      const messageId = "om_card_1";
      messages.push({ chatId, card, messageId });
      const action = card.elements
        .find((element) => element.tag === "action")
        .actions.find((button) => button.value.decision === "approve").value;
      setImmediate(() => broker.decideCard({
        senderId: job.senderId, chatId, messageId,
        actionId: action.actionId, approved: true,
      }));
      return { messageId };
    },
  };
  broker = new ApprovalBroker({
    lark,
    config: baseConfig(repositoryPath),
    lookupJob: (threadId, turnId) => (
      threadId === "thread-1" && turnId === "turn-1" ? job : null
    ),
    timeoutMs: 5_000,
    logger: { info() {}, error() {} },
  });
  broker.setCardActionsAvailable(true);
  const server = new HookApprovalServer((request) => handleHookApproval(request, broker), {
    timeoutMs: 5_000,
    logger: { error() {} },
  });
  t.after(async () => {
    broker.declineAll("test_finished");
    await server.stop();
  });

  const request = {
    session_id: "thread-1",
    turn_id: "turn-1",
    transcript_path: null,
    cwd: repositoryPath,
    hook_event_name: "PreToolUse",
    model: "test-model",
    permission_mode: "untrusted",
    tool_name: "Bash",
    tool_input: { command: "node --version" },
    tool_use_id: "exec-1",
  };
  assert.deepEqual((await runHook(request, await server.start())).hookSpecificOutput, {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: request.tool_input,
  });
  assert.equal(messages.length, 1);

  assert.deepEqual(await broker.handle({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "exec-1",
      startedAtMs: Date.now(),
      approvalId: null,
      environmentId: "local",
      reason: null,
      networkApprovalContext: null,
      cwd: repositoryPath,
      command: '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -NoProfile -Command \'node --version\'',
      commandActions: [{ type: "unknown", command: "node --version" }],
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      availableDecisions: ["accept", "acceptForSession", "decline"],
    },
  }), { decision: "accept" });
  assert.equal(messages.length, 1);
});
