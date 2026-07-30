import assert from "node:assert/strict";
import test from "node:test";
import { PRE_TOOL_APPROVAL_METHOD } from "../src/approval-broker.js";
import { handleHookApproval, isFailedApprovalHook } from "../src/hook-approval-handler.js";

test("maps canonical PreToolUse fields to one ApprovalBroker request", async () => {
  let received;
  const request = {
    session_id: "thread-1",
    turn_id: "turn-1",
    cwd: "C:\\repo",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "Get-Content package.json" },
    tool_use_id: "tool-1",
  };
  const result = await handleHookApproval(request, {
    async handle(value) {
      received = value;
      return { decision: "accept" };
    },
  });
  assert.deepEqual(result, { approved: true });
  assert.deepEqual(received, {
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-1",
      cwd: "C:\\repo",
      toolName: "Bash",
      toolInput: request.tool_input,
      command: "Get-Content package.json",
    },
  });
});

test("fails closed before the broker is ready or for a non-PreToolUse event", async () => {
  assert.equal((await handleHookApproval({}, null)).approved, false);
  let called = false;
  const result = await handleHookApproval({ hook_event_name: "PostToolUse" }, {
    async handle() {
      called = true;
      return { decision: "accept" };
    },
  });
  assert.deepEqual(result, { approved: false, reason: "approval service is not ready" });
  assert.equal(called, false);
});

test("maps broker declines and unknown responses to a denial", async () => {
  const request = {
    hook_event_name: "PreToolUse",
    tool_input: { command: "*** Begin Patch" },
  };
  for (const response of [{ decision: "decline" }, null]) {
    assert.deepEqual(await handleHookApproval(request, {
      async handle() { return response; },
    }), { approved: false, reason: "operation was not approved" });
  }
});

test("identifies only failed PreToolUse completions as fatal", () => {
  assert.equal(isFailedApprovalHook({ run: { eventName: "preToolUse", status: "failed" } }), true);
  assert.equal(isFailedApprovalHook({ run: { eventName: "preToolUse", status: "blocked" } }), false);
  assert.equal(isFailedApprovalHook({ run: { eventName: "postToolUse", status: "failed" } }), false);
  assert.equal(isFailedApprovalHook(null), false);
});
