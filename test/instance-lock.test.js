import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InstanceLock, requestBridgeShutdown } from "../src/instance-lock.js";

function controlAddress(dataDirectory) {
  const identity = path.resolve(dataDirectory).toLowerCase();
  const digest = createHash("sha256").update(identity).digest();
  const name = `feishu-codex-bridge-${digest.toString("hex").slice(0, 32)}`;
  if (process.platform === "win32") return { path: `\\\\.\\pipe\\${name}` };
  if (process.platform === "linux") return { path: `\0${name}` };
  return { host: "127.0.0.1", port: 49_152 + digest.readUInt16BE(0) % 16_384 };
}

function sendRawControl(dataDirectory, message) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlAddress(dataDirectory));
    let output = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(output.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

test("prevents two live bridge instances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-lock-"));
  const first = await new InstanceLock(directory, { pid: 101, isProcessAlive: () => true }).acquire();
  const second = new InstanceLock(directory, { pid: 202, isProcessAlive: () => true });
  await assert.rejects(second.acquire(), /already running.*101/);
  await first.release();
  await second.acquire();
  await second.release();
});

test("reclaims a stale or old malformed bridge lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-lock-"));
  const filePath = path.join(directory, "bridge.lock");
  await writeFile(filePath, JSON.stringify({ pid: 303 }));
  const stale = new InstanceLock(directory, { pid: 404, isProcessAlive: () => false });
  await stale.acquire();
  await stale.release();

  await writeFile(filePath, "not-json");
  const malformed = new InstanceLock(directory, {
    pid: 505,
    isProcessAlive: () => false,
    malformedGraceMs: 0,
  });
  await malformed.acquire();
  await malformed.release();
});

test("does not reclaim a newly-created lock before its owner metadata is written", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-lock-"));
  await writeFile(path.join(directory, "bridge.lock"), "");
  const contender = new InstanceLock(directory, { pid: 909, isProcessAlive: () => false });
  await assert.rejects(contender.acquire(), /acquiring the instance lock/);
});

test("release cannot delete a lock replaced by another owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-lock-"));
  const first = await new InstanceLock(directory, { pid: 606, isProcessAlive: () => true }).acquire();
  await writeFile(first.filePath, JSON.stringify({ pid: 707 }));
  await first.release();
  const replacement = new InstanceLock(directory, { pid: 808, isProcessAlive: (pid) => pid === 707 });
  await assert.rejects(replacement.acquire(), /already running.*707/);
});

test("stale-lock recovery cannot delete a concurrently acquired lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-lock-"));
  await writeFile(path.join(directory, "bridge.lock"), JSON.stringify({ pid: 303 }));
  let releaseOwnerRead;
  const ownerReadBlocked = new Promise((resolve) => { releaseOwnerRead = resolve; });
  let ownerReadStarted;
  const ownerReadObserved = new Promise((resolve) => { ownerReadStarted = resolve; });
  const first = new InstanceLock(directory, { pid: 111, isProcessAlive: () => false });
  const readOwner = first.readOwner.bind(first);
  first.readOwner = async () => {
    ownerReadStarted();
    await ownerReadBlocked;
    return readOwner();
  };

  const firstAcquire = first.acquire();
  await ownerReadObserved;
  const second = new InstanceLock(directory, { pid: 222, isProcessAlive: () => false });
  await assert.rejects(second.acquire(), /already running/);
  assert.equal(second.handle, null);
  releaseOwnerRead();
  await firstAcquire;
  await first.release();
});

test("requests a graceful shutdown through the live instance lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-lock-"));
  const lock = await new InstanceLock(directory, { pid: 1_234 }).acquire();
  const requests = [];
  lock.registerControlHandler((request) => {
    requests.push(request);
    return true;
  });

  const result = await requestBridgeShutdown(directory);
  assert.deepEqual(result, { pid: 1_234 });
  assert.deepEqual(requests, [{ action: "shutdown" }]);
  await lock.release();
});

test("rejects shutdown when the bridge lock token was replaced", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-lock-"));
  const lock = await new InstanceLock(directory, { pid: 2_345 }).acquire();
  let called = false;
  lock.registerControlHandler(() => {
    called = true;
    return true;
  });
  await writeFile(lock.filePath, `${JSON.stringify({
    pid: lock.pid,
    token: randomUUID(),
  })}\n`);

  await assert.rejects(requestBridgeShutdown(directory), /shutdown request was rejected/);
  assert.equal(called, false);
  await writeFile(lock.filePath, `${JSON.stringify({ pid: lock.pid, token: lock.token })}\n`);
  await lock.release();
});

test("accepts only the shutdown control action", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-lock-"));
  const lock = await new InstanceLock(directory, { pid: 3_456 }).acquire();
  let called = false;
  lock.registerControlHandler(() => {
    called = true;
    return true;
  });

  assert.deepEqual(
    await sendRawControl(directory, { action: "restart", token: lock.token }),
    { ok: false },
  );
  assert.equal(called, false);
  await lock.release();
});

test("control handler errors and timeouts fail closed", async (t) => {
  await t.test("handler error", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-lock-"));
    const lock = await new InstanceLock(directory, { pid: 4_567 }).acquire();
    lock.registerControlHandler(() => {
      throw new Error("handler secret detail");
    });
    await assert.rejects(requestBridgeShutdown(directory), /shutdown request was rejected/);
    await lock.release();
  });

  await t.test("client timeout", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-lock-"));
    const lock = await new InstanceLock(directory, { pid: 5_678 }).acquire();
    lock.registerControlHandler(() => new Promise(() => {}));
    await assert.rejects(
      requestBridgeShutdown(directory, { timeoutMs: 25 }),
      /timed out/,
    );
    await lock.release();
  });
});
