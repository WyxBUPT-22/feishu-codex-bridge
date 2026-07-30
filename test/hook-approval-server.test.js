import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  HOOK_APPROVAL_TIMEOUT_MS,
  HOOK_CLIENT_TIMEOUT_MS,
  HOOK_COMMAND_TIMEOUT_SECONDS,
  HOOK_IPC_TIMEOUT_MS,
  HookApprovalServer,
  hookEndpointPath,
} from "../src/hook-approval-server.js";

function exchange(endpoint, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(hookEndpointPath(endpoint));
    let output = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("IPC test timed out"));
    }, 2_000);
    socket.once("connect", () => socket.write(message));
    socket.on("data", (chunk) => {
      output = Buffer.concat([output, chunk]);
    });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      if (output.length === 0) return;
      try {
        resolve(JSON.parse(output.toString("utf8").trim()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("HookApprovalServer approves one eligible request and exposes its endpoint", async (t) => {
  let received;
  const server = new HookApprovalServer(async (request) => {
    received = request;
    return { approved: true };
  }, { logger: { error() {} } });
  t.after(() => server.stop());
  const endpoint = await server.start();
  assert.equal(server.endpoint, endpoint);
  assert.equal(typeof endpoint, "string");
  assert.ok(endpoint.length > 20);

  const request = { tool_name: "Bash", tool_input: { command: "npm test" }, marker: 42 };
  assert.deepEqual(await exchange(endpoint, `${JSON.stringify(request)}\n`), { approved: true });
  assert.deepEqual(received, request);
});

test("production timeouts outlive human approval in fail-closed order", () => {
  assert.equal(HOOK_APPROVAL_TIMEOUT_MS, 10 * 60_000);
  assert.ok(HOOK_IPC_TIMEOUT_MS > HOOK_APPROVAL_TIMEOUT_MS);
  assert.ok(HOOK_CLIENT_TIMEOUT_MS > HOOK_IPC_TIMEOUT_MS);
  assert.ok(HOOK_COMMAND_TIMEOUT_SECONDS * 1_000 > HOOK_CLIENT_TIMEOUT_MS);
  assert.ok(HOOK_IPC_TIMEOUT_MS > 15_000);
});

test("a handler may approve before an injected server deadline", async (t) => {
  const server = new HookApprovalServer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { approved: true };
  }, { timeoutMs: 100, logger: { error() {} } });
  t.after(() => server.stop());
  assert.deepEqual(
    await exchange(await server.start(), '{"tool_name":"Bash","tool_input":{}}\n'),
    { approved: true },
  );
});

test("HookApprovalServer preserves a handler rejection reason", async (t) => {
  const server = new HookApprovalServer(
    async () => ({ approved: false, reason: "not approved in Feishu" }),
    { logger: { error() {} } },
  );
  t.after(() => server.stop());
  const endpoint = await server.start();
  assert.deepEqual(await exchange(endpoint, '{"tool_name":"apply_patch","tool_input":{}}\n'), {
    approved: false,
    reason: "not approved in Feishu",
  });
});

test("HookApprovalServer fails closed for malformed, multiple, and unsupported requests", async (t) => {
  let calls = 0;
  const server = new HookApprovalServer(async () => {
    calls += 1;
    return { approved: true };
  }, { logger: { error() {} } });
  t.after(() => server.stop());
  const endpoint = await server.start();

  assert.equal((await exchange(endpoint, "not-json\n")).approved, false);
  assert.equal((await exchange(endpoint, "{}\n{}\n")).approved, false);
  assert.deepEqual(await exchange(endpoint, '{"tool_name":"mcp_call","tool_input":{}}\n'), {
    approved: false,
    reason: "tool is not eligible for approval",
  });
  assert.equal(calls, 0);
});

test("HookApprovalServer rejects oversized messages before invoking the handler", async (t) => {
  let calls = 0;
  const server = new HookApprovalServer(async () => {
    calls += 1;
    return { approved: true };
  }, { maxMessageBytes: 256, logger: { error() {} } });
  t.after(() => server.stop());
  const endpoint = await server.start();
  const request = { tool_name: "shell", tool_input: { command: "x".repeat(400) } };
  const response = await exchange(endpoint, `${JSON.stringify(request)}\n`);
  assert.equal(response.approved, false);
  assert.match(response.reason, /size limit/);
  assert.equal(calls, 0);
});

test("HookApprovalServer handler errors and timeouts fail closed", async (t) => {
  const throwing = new HookApprovalServer(async () => {
    throw null;
  }, { logger: { error() { throw new Error("logger failed"); } } });
  t.after(() => throwing.stop());
  assert.deepEqual(
    await exchange(await throwing.start(), '{"tool_name":"unified_exec","tool_input":{}}\n'),
    { approved: false, reason: "approval handler failed" },
  );

  const hanging = new HookApprovalServer(() => new Promise(() => {}), {
    timeoutMs: 30,
    logger: { error() {} },
  });
  t.after(() => hanging.stop());
  const response = await exchange(
    await hanging.start(),
    '{"tool_name":"exec_command","tool_input":{}}\n',
  );
  assert.equal(response.approved, false);
  assert.match(response.reason, /timed out/);
});

test("HookApprovalServer stop is idempotent and closes the endpoint", async () => {
  const server = new HookApprovalServer(async () => ({ approved: true }), {
    logger: { error() {} },
  });
  const endpoint = await server.start();
  await Promise.all([server.stop(), server.stop()]);
  await server.stop();
  await assert.rejects(exchange(endpoint, '{"tool_name":"Bash","tool_input":{}}\n'));
});
