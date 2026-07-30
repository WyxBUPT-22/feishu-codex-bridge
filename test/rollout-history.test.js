import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rolloutForkCutoff } from "../src/rollout-history.js";

const THREAD_ID = "01900000-0000-7000-8000-000000000002";

async function fixture(events) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "rollout-cutoff-"));
  const directory = path.join(codexHome, "sessions", "2026", "07", "27");
  await mkdir(directory, { recursive: true });
  const records = events.map((payload) => JSON.stringify({
    timestamp: "2026-07-27T00:00:00.000Z",
    type: "event_msg",
    payload,
  }));
  await writeFile(path.join(directory, `rollout-${THREAD_ID}.jsonl`), `${records.join("\n")}\n`);
  return codexHome;
}

test("selects the last terminal turn before a residual started turn", async () => {
  const codexHome = await fixture([
    { type: "task_started", turn_id: "turn-complete" },
    { type: "task_complete", turn_id: "turn-complete" },
    { type: "task_started", turn_id: "turn-interrupted" },
    { type: "turn_aborted", turn_id: "turn-interrupted" },
    { type: "task_started", turn_id: "turn-residual" },
    { type: "task_started", turn_id: "turn-later" },
    { type: "task_complete", turn_id: "turn-later" },
  ]);

  const result = await rolloutForkCutoff(THREAD_ID, { codexHome });

  assert.equal(result.hasResidual, true);
  assert.equal(result.lastTurnId, "turn-interrupted");
});

test("reports no cutoff when every started turn is terminal", async () => {
  const codexHome = await fixture([
    { type: "task_started", turn_id: "turn-complete" },
    { type: "task_complete", turn_id: "turn-complete" },
  ]);

  assert.deepEqual(
    await rolloutForkCutoff(THREAD_ID, { codexHome }),
    {
      rolloutPath: path.join(
        codexHome,
        "sessions",
        "2026",
        "07",
        "27",
        `rollout-${THREAD_ID}.jsonl`,
      ),
      hasResidual: false,
      lastTurnId: null,
    },
  );
});
