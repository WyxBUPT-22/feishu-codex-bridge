import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HookApprovalServer } from "../src/hook-approval-server.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.resolve(testDirectory, "../src/pre-tool-approval-hook.mjs");

function hookRequest(overrides = {}) {
  return {
    session_id: "thread-1",
    turn_id: "turn-1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    model: "test-model",
    permission_mode: "never",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_use_id: "tool-1",
    ...overrides,
  };
}

function runHook(input, endpoint) {
  return new Promise((resolve, reject) => {
    const args = [hookPath];
    if (endpoint !== undefined) args.push(endpoint);
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(testDirectory, ".."),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("hook process timed out"));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        resolve({ code, stderr, output: JSON.parse(stdout.trim()) });
      } catch (error) {
        reject(new Error(`invalid hook stdout: ${stdout}; ${error.message}`));
      }
    });
    child.stdin.end(input);
  });
}

function specific(result) {
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  return result.output.hookSpecificOutput;
}

test("PreToolUse hook forwards the complete request and emits an allow rewrite", async (t) => {
  let received;
  const server = new HookApprovalServer(async (request) => {
    received = request;
    return { approved: true };
  }, { logger: { error() {} } });
  t.after(() => server.stop());
  const request = hookRequest();
  const result = await runHook(JSON.stringify(request), await server.start());
  assert.deepEqual(received, request);
  assert.deepEqual(specific(result), {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: request.tool_input,
  });
});

test("PreToolUse hook emits a deny decision with the server reason", async (t) => {
  const server = new HookApprovalServer(
    async () => ({ approved: false, reason: "user declined" }),
    { logger: { error() {} } },
  );
  t.after(() => server.stop());
  assert.deepEqual(specific(await runHook(
    JSON.stringify(hookRequest({ tool_name: "apply_patch", tool_input: { command: "***" } })),
    await server.start(),
  )), {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "user declined",
  });
});

test("PreToolUse hook fails closed when the approval server is unavailable", async () => {
  const server = new HookApprovalServer(async () => ({ approved: true }), {
    logger: { error() {} },
  });
  const endpoint = await server.start();
  await server.stop();
  const output = specific(await runHook(JSON.stringify(hookRequest()), endpoint));
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /unavailable|closed/);
});

test("PreToolUse hook denies malformed input and unsupported tools without IPC", async () => {
  const malformed = specific(await runHook("{broken-json"));
  assert.equal(malformed.permissionDecision, "deny");
  assert.match(malformed.permissionDecisionReason, /valid JSON/);

  const unsupported = specific(await runHook(JSON.stringify(hookRequest({
    tool_name: "mcp_call",
    tool_input: { server: "external" },
  }))));
  assert.equal(unsupported.permissionDecision, "deny");
  assert.match(unsupported.permissionDecisionReason, /not eligible/);

  for (const overrides of [
    { session_id: "" },
    { turn_id: "" },
    { tool_use_id: "" },
    { cwd: "" },
    { hook_event_name: "PostToolUse" },
  ]) {
    const invalid = specific(await runHook(JSON.stringify(hookRequest(overrides))));
    assert.equal(invalid.permissionDecision, "deny");
    assert.match(invalid.permissionDecisionReason, /malformed/);
  }
});

test("PreToolUse hook denies oversized stdin", async () => {
  const request = hookRequest({ tool_input: { command: "x".repeat(256 * 1024) } });
  const output = specific(await runHook(JSON.stringify(request)));
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /size limit/);
});
