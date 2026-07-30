import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  attachHookDirectoryCleanup,
  awaitStartupOperation,
  createIsolatedHookDirectory,
  resetIsolatedConfig,
} from "../src/isolated-app-server.js";

test("resets persistent isolated config before app-server startup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-isolated-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.toml");
  await writeFile(configPath, '[mcp_servers.unexpected]\ncommand = "unsafe"\n', "utf8");

  await resetIsolatedConfig(root);

  assert.equal(
    await readFile(configPath, "utf8"),
    "# Managed by feishu-codex-bridge.\n",
  );

  await rm(configPath);
  await mkdir(configPath);
  await assert.rejects(
    resetIsolatedConfig(root),
    /config path is not a regular file/,
  );
});

test("creates unique per-instance hook directories and removes them after client stop", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-hook-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await createIsolatedHookDirectory(root);
  const second = await createIsolatedHookDirectory(root);
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), path.join(root, "bridge-hooks"));
  assert.equal(path.dirname(second), path.join(root, "bridge-hooks"));

  class FakeClient extends EventEmitter {
    async stop() {
      this.emit("close", { expected: true });
    }
  }
  const firstClient = attachHookDirectoryCleanup(new FakeClient(), first);
  const secondClient = attachHookDirectoryCleanup(new FakeClient(), second);
  await Promise.all([firstClient.stop(), secondClient.stop()]);
  await assert.rejects(access(first), (error) => error.code === "ENOENT");
  await assert.rejects(access(second), (error) => error.code === "ENOENT");
});

test("startup AbortSignal stops the current client and returns STARTUP_SHUTDOWN", async () => {
  const controller = new AbortController();
  let stopped = 0;
  const client = {
    async stop() {
      stopped += 1;
    },
  };
  const operation = new Promise(() => {});
  const waiting = awaitStartupOperation(client, operation, controller.signal);
  controller.abort(new Error("SIGTERM"));
  await assert.rejects(waiting, (error) => (
    error?.name === "AbortError" && error?.code === "STARTUP_SHUTDOWN"
  ));
  assert.equal(stopped, 1);
});
