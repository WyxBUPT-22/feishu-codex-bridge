import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { monitorAppServer } from "../src/app-server-lifecycle.js";

function appServer(alive = true) {
  const client = new EventEmitter();
  client.child = alive ? {} : null;
  return client;
}

test("captures an app-server close before the first startup wait", async () => {
  const client = appServer();
  const guard = monitorAppServer(client);

  client.emit("close", { code: 17, signal: null, expected: false });

  await assert.rejects(
    guard.waitFor(new Promise(() => {})),
    (error) => error.code === "APP_SERVER_EXITED" && /code=17/.test(error.message),
  );
  guard.dispose();
  assert.equal(client.listenerCount("close"), 0);
});

test("fails startup when the returned app-server is already not alive", async () => {
  const guard = monitorAppServer(appServer(false));

  await assert.rejects(
    guard.waitFor(Promise.resolve()),
    (error) => error.code === "APP_SERVER_EXITED",
  );
});

test("keeps startup fatal monitoring active until runtime activation", async () => {
  const client = appServer();
  const guard = monitorAppServer(client);
  await guard.waitFor(Promise.resolve());

  client.emit("close", { code: 23, signal: null, expected: false });

  assert.throws(
    () => guard.activateRuntime(),
    (error) => error.code === "APP_SERVER_EXITED" && /code=23/.test(error.message),
  );
});

test("routes unexpected runtime close exactly once and ignores expected close", () => {
  const client = appServer();
  const failures = [];
  const guard = monitorAppServer(client, {
    onRuntimeExit: (error, details) => failures.push({ error, details }),
  });
  guard.activateRuntime();

  client.emit("close", { code: 0, signal: null, expected: true });
  client.emit("close", { code: 31, signal: null, expected: false });
  client.emit("close", { code: 32, signal: null, expected: false });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].error.code, "APP_SERVER_EXITED");
  assert.equal(failures[0].details.code, 31);
});
