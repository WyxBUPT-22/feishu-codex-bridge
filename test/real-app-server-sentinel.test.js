import assert from "node:assert/strict";
import test from "node:test";
import { PRE_TOOL_APPROVAL_METHOD } from "../src/approval-broker.js";
import {
  createExactApprovalValidator,
  deleteThreads,
  parseSentinelArgs,
  runSentinel,
} from "../scripts/real-app-server-sentinel.mjs";

const THREAD_ID = "01900000-0000-7000-8000-000000000003";
const AGENT_JOBS_ERROR = `failed to delete app-server state for ${THREAD_ID}: error returned from database: (code: 1) no such table: agent_jobs`;

test("real app-server sentinel requires an explicit run flag and parses safe options", () => {
  assert.deepEqual(parseSentinelArgs([]), {
    configPath: "bridge.config.json",
    repository: null,
    approvalTimeoutMs: 300,
    only: null,
    includeIpcFailure: false,
    run: false,
    help: false,
  });
  assert.deepEqual(parseSentinelArgs([
    "--run",
    "--config", "custom.json",
    "--repository", "repo",
    "--approval-timeout-ms", "250",
    "--only", "balanced-trusted-read",
    "--include-ipc-failure",
  ]), {
    configPath: "custom.json",
    repository: "repo",
    approvalTimeoutMs: 250,
    only: "balanced-trusted-read",
    includeIpcFailure: true,
    run: true,
    help: false,
  });
  assert.throws(
    () => parseSentinelArgs(["--approval-timeout-ms", "10"]),
    /integer from 50 to 5000/,
  );
});

test("sentinel performs no configuration or model work without --run", async () => {
  await assert.rejects(
    runSentinel(parseSentinelArgs([])),
    /Real model calls are disabled by default/,
  );
});

test("sentinel auto-approval validators accept only the exact hook envelope", () => {
  const commandValidator = createExactApprovalValidator({
    toolName: "Bash",
    command: "Get-Content -LiteralPath '.sentinel/read.txt'",
    cwd: "C:\\repo",
  });
  assert.equal(commandValidator({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      toolName: "Bash",
      command: "  Get-Content   -LiteralPath '.sentinel/read.txt'  ",
      cwd: "C:\\repo",
    },
  }), true);
  assert.equal(commandValidator({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: { toolName: "Bash", command: "Get-Content C:\\secret.txt", cwd: "C:\\repo" },
  }), false);
  assert.equal(commandValidator({
    method: "item/commandExecution/requestApproval",
    params: {
      toolName: "Bash",
      command: "Get-Content -LiteralPath '.sentinel/read.txt'",
      cwd: "C:\\repo",
    },
  }), false);
  assert.equal(commandValidator({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      toolName: "Bash",
      command: "Get-Content -LiteralPath '.sentinel/read.txt'",
      cwd: "C:\\repo\\subdir",
    },
  }), false);

  const patch = "*** Begin Patch\n*** Add File: .sentinel/token.txt\n+token\n*** End Patch";
  const patchValidator = createExactApprovalValidator({
    toolName: "apply_patch",
    patch,
    cwd: "C:\\repo",
  });
  assert.equal(patchValidator({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: { toolName: "apply_patch", toolInput: { command: patch }, cwd: "C:\\repo" },
  }), true);
  assert.equal(patchValidator({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      toolName: "apply_patch",
      toolInput: { command: `${patch}\n*** Add File: ../outside.txt\n+bad` },
      cwd: "C:\\repo",
    },
  }), false);
});

test("sentinel thread cleanup reports a successful delete", async () => {
  const calls = [];
  const result = await deleteThreads({
    async request(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs });
    },
    async readThread() { assert.fail("thread/read is not part of cleanup verification"); },
  }, new Set([THREAD_ID]));

  assert.deepEqual(result, { deleted: 1, verifiedAbsent: 0, warnings: [], errors: [] });
  assert.deepEqual(calls, [{
    method: "thread/delete",
    params: { threadId: THREAD_ID },
    timeoutMs: 30_000,
  }]);
});

test("sentinel cleanup downgrades only an exact agent_jobs failure with exact absence", async () => {
  const result = await deleteThreads({
    async request() { throw new Error(AGENT_JOBS_ERROR); },
  }, new Set([THREAD_ID]), {
    async findRollout(threadId) {
      assert.equal(threadId, THREAD_ID);
      return null;
    },
  });

  assert.equal(result.deleted, 0);
  assert.equal(result.verifiedAbsent, 1);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.errors, []);
});

test("sentinel cleanup fails when the rollout still exists after the known database error", async () => {
  const result = await deleteThreads({
    async request() { throw new Error(AGENT_JOBS_ERROR); },
  }, new Set([THREAD_ID]), {
    async findRollout() { return { rolloutPath: "C:\\sessions\\rollout.jsonl" }; },
  });

  assert.equal(result.verifiedAbsent, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /rollout still exists/);
});

test("sentinel cleanup preserves unknown delete and absence-verification errors", async () => {
  const otherId = "01900000-0000-7000-8000-000000000004";
  const unknownDelete = await deleteThreads({
    async request() { throw new Error("no such table: another_table"); },
    async readThread() { assert.fail("thread/read must not run"); },
  }, new Set([THREAD_ID]));
  assert.equal(unknownDelete.errors.length, 1);
  assert.equal(unknownDelete.errors[0].message, "no such table: another_table");

  const verification = await deleteThreads({
    async request() { throw new Error(AGENT_JOBS_ERROR); },
  }, new Set([THREAD_ID]), {
    async findRollout(threadId) {
      assert.notEqual(threadId, otherId);
      throw new Error("rollout scan failed");
    },
  });
  assert.equal(verification.verifiedAbsent, 0);
  assert.equal(verification.errors.length, 1);
  assert.match(verification.errors[0].message, /rollout verification failed/);
});
