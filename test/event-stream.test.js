import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventStream } from "../src/event-stream.js";

test("builds a dedicated consumer command for each event key", () => {
  const message = new EventStream({}, { lark: { profile: "profile-1" } });
  assert.deepEqual(message.args(), [
    "--profile", "profile-1", "event", "consume", "im.message.receive_v1", "--as", "bot",
  ]);
  assert.equal(message.readyMarker, "[event] ready event_key=im.message.receive_v1");

  const card = new EventStream({}, { lark: { profile: null } }, "card.action.trigger");
  assert.deepEqual(card.args(), ["event", "consume", "card.action.trigger", "--as", "bot"]);
  assert.equal(card.readyMarker, "[event] ready event_key=card.action.trigger");
});

test("requires an exact ready marker and drops events from the wrong stream", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-event-stream-"));
  const script = path.join(directory, "fake-stream.mjs");
  await writeFile(script, `
process.stderr.write("prefix [event] ready event_key=card.action.trigger suffix\\n");
process.stdout.write(JSON.stringify({ type: "im.message.receive_v1" }) + "\\n");
setTimeout(() => {
  process.stderr.write("[event] ready event_key=card.action.trigger\\n");
  process.stdout.write(JSON.stringify({ type: "card.action.trigger", event_id: "evt_1" }) + "\\n");
}, 10);
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
  const stream = new EventStream({
    command: process.execPath,
    prefixArgs: [script],
    displayName: "fake-stream",
  }, { lark: { profile: null } }, "card.action.trigger");
  const warnings = [];
  const events = [];
  let readyCount = 0;
  stream.on("warning", (message) => warnings.push(message));
  stream.on("event", (event) => events.push(event));
  stream.on("ready", () => { readyCount += 1; });
  try {
    stream.start();
    await once(stream, "ready");
    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(readyCount, 1);
    assert.equal(events[0].type, "card.action.trigger");
    assert.equal(warnings.some((message) => message.includes("im.message.receive_v1")), true);
  } finally {
    await stream.stop({ timeoutMs: 500 });
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop closes stdin and waits for the consumer", async () => {
  const stream = new EventStream({}, { lark: { profile: null } });
  const child = new EventEmitter();
  let ended = false;
  child.stdin = { end() { ended = true; queueMicrotask(() => child.emit("close", 0, null)); } };
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  stream.child = child;
  child.once("close", () => { stream.child = null; });
  assert.equal(await stream.stop({ timeoutMs: 100 }), true);
  assert.equal(ended, true);
  assert.equal(stream.stopping, true);
});

test("stop is idempotent without a child", async () => {
  const stream = new EventStream({}, { lark: { profile: null } });
  assert.equal(await stream.stop(), false);
});
