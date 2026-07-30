import assert from "node:assert/strict";
import test from "node:test";
import { JobQueue } from "../src/job-queue.js";

test("a synchronous handler failure does not strand the queue in running state", async () => {
  const failure = new Error("synchronous handler failure");
  const failed = [];
  const queue = new JobQueue(1, () => { throw failure; });
  queue.on("failed", (job, error) => failed.push({ job, error }));

  const job = { id: "sync-failure" };
  queue.add(job);
  await queue.whenIdle();

  assert.deepEqual(failed, [{ job, error: failure }]);
  assert.deepEqual(queue.status(), { pending: [], running: [] });
});
