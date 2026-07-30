import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  hasExactReadyMarkers,
  replaceRuntime,
  runtimeReadyMarkers,
} from "../scripts/deploy-runtime.mjs";

function target(name) {
  return {
    runtimeDirectory: path.resolve(name),
    manifestSha256: "a".repeat(64),
    bootstrapPath: path.resolve("bootstrap.mjs"),
    bootstrapSha256: "b".repeat(64),
    fileCount: 36,
    configSource: path.resolve("canonical.json"),
    configSourceSha256: "c".repeat(64),
  };
}

test("requires all four readiness markers as exact complete lines", () => {
  const markers = runtimeReadyMarkers(36);
  assert.equal(hasExactReadyMarkers(`${markers.join("\n")}\n`, markers), true);
  assert.equal(hasExactReadyMarkers(`${markers.slice(0, 3).join("\n")}\n`, markers), false);
  assert.equal(
    hasExactReadyMarkers(`prefix ${markers.join(" suffix\n")} suffix\n`, markers),
    false,
  );
  assert.equal(
    hasExactReadyMarkers(runtimeReadyMarkers(35).join("\n"), markers),
    false,
  );
});

test("updates active deployment state only after the new runtime is ready", async () => {
  const events = [];
  const next = target("next");
  const result = await replaceRuntime({
    dataDirectory: path.resolve("data"),
    target: next,
    previousTarget: target("previous"),
    runningOwner: { pid: 10 },
    readyTimeoutMs: 1,
    stopTimeoutMs: 1,
  }, {
    stop: async () => { events.push("stop"); },
    start: async (selected) => {
      events.push(`start:${path.basename(selected.runtimeDirectory)}`);
      return { pid: 20, stdoutPath: "out", stderrPath: "err" };
    },
    waitReady: async (selected) => {
      events.push(`ready:${path.basename(selected.runtimeDirectory)}`);
    },
    cleanup: async () => { events.push("cleanup"); },
    saveState: async (_dataDirectory, active) => {
      events.push(`save:${path.basename(active.runtimeDirectory)}`);
    },
  });
  assert.deepEqual(events, ["stop", "start:next", "ready:next", "save:next"]);
  assert.equal(result.rolledBack, false);
  assert.equal(result.active.pid, 20);
});

test("restores and re-verifies the previous runtime before saving rollback state", async () => {
  const events = [];
  const next = target("next");
  const previous = target("previous");
  let nextReadinessFailed = false;
  await assert.rejects(
    replaceRuntime({
      dataDirectory: path.resolve("data"),
      target: next,
      previousTarget: previous,
      runningOwner: { pid: 10 },
      readyTimeoutMs: 1,
      stopTimeoutMs: 1,
    }, {
      stop: async () => { events.push("stop"); },
      start: async (selected) => {
        const name = path.basename(selected.runtimeDirectory);
        events.push(`start:${name}`);
        return {
          pid: name === "next" ? 20 : 30,
          stdoutPath: "out",
          stderrPath: "err",
        };
      },
      waitReady: async (selected) => {
        const name = path.basename(selected.runtimeDirectory);
        events.push(`ready:${name}`);
        if (name === "next" && !nextReadinessFailed) {
          nextReadinessFailed = true;
          throw new Error("not ready");
        }
      },
      cleanup: async (started) => { events.push(`cleanup:${started.pid}`); },
      saveState: async (_dataDirectory, active, extra) => {
        events.push(`save:${path.basename(active.runtimeDirectory)}`);
        assert.equal(extra.rollback.failedRuntimeDirectory, next.runtimeDirectory);
      },
    }),
    (error) => error.code === "DEPLOYMENT_ROLLED_BACK",
  );
  assert.deepEqual(events, [
    "stop",
    "start:next",
    "ready:next",
    "cleanup:20",
    "start:previous",
    "ready:previous",
    "save:previous",
  ]);
});

test("refuses to stop a live bridge without a verified rollback target", async () => {
  let stopped = false;
  await assert.rejects(
    replaceRuntime({
      dataDirectory: path.resolve("data"),
      target: target("next"),
      previousTarget: null,
      runningOwner: { pid: 10 },
      readyTimeoutMs: 1,
      stopTimeoutMs: 1,
    }, {
      stop: async () => { stopped = true; },
    }),
    /no verified rollback target/,
  );
  assert.equal(stopped, false);
});
