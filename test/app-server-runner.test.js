import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  AppServerRunner,
  sandboxPolicy,
  transientTurnListError,
} from "../src/app-server-runner.js";
import { baseConfig } from "./helpers.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeClient extends EventEmitter {
  async startThread(params) {
    this.startThreadParams = params;
    return { thread: { id: "thread-1", status: { type: "idle" } } };
  }
  async resumeThread({ threadId }) {
    return { thread: { id: threadId, status: { type: "idle" } } };
  }
  async startTurn(params) {
    this.startTurnParams = params;
    setImmediate(() => {
      this.emit("item/agentMessage/delta", {
        threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "完成",
      });
      this.emit("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "完成", phase: "final_answer" }],
        },
      });
    });
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  }
  async interruptTurn() {}
  async listTurns() {
    return { data: [{ id: "turn-1", status: "inProgress" }] };
  }
}

test("runs a turn through app-server and preserves the result contract", async () => {
  const client = new FakeClient();
  const runner = new AppServerRunner(client, baseConfig());
  const result = await runner.run(
    { id: "job-1", sourceMessageId: "om_1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "测试" },
  );
  assert.equal(result.code, 0);
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.lastMessage, "完成");
  assert.equal(result.completed, true);
  assert.deepEqual(client.startThreadParams.dynamicTools, []);
  assert.deepEqual(client.startThreadParams.selectedCapabilityRoots, []);
  assert.equal(client.startThreadParams.historyMode, "legacy");
  assert.equal(Object.hasOwn(client.startThreadParams, "environments"), false);
  assert.equal(Object.hasOwn(client.startTurnParams, "environments"), false);
  assert.deepEqual(client.startTurnParams.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["C:\\repo"],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
});

test("publishes commentary deltas but not final-answer deltas as progress", async () => {
  const client = new FakeClient();
  client.startTurn = async () => {
    setImmediate(() => {
      client.emit("item/started", {
        threadId: "thread-1", turnId: "turn-1",
        item: { id: "commentary-1", type: "agentMessage", phase: "commentary" },
      });
      client.emit("item/agentMessage/delta", {
        threadId: "thread-1", turnId: "turn-1", itemId: "commentary-1", delta: "正在检查",
      });
      client.emit("item/started", {
        threadId: "thread-1", turnId: "turn-1",
        item: { id: "final-1", type: "agentMessage", phase: "final_answer" },
      });
      client.emit("item/agentMessage/delta", {
        threadId: "thread-1", turnId: "turn-1", itemId: "final-1", delta: "最终答案",
      });
      client.emit("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "最终答案", phase: "final_answer" }],
        },
      });
    });
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  const runner = new AppServerRunner(client, baseConfig());
  const progress = [];
  runner.on("progress", (event) => progress.push(event));

  await runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.deepEqual(progress.filter((event) => event.type === "text").map((event) => event.delta), [
    "正在检查",
  ]);
});

test("uses an exact repository-only workspace-write policy", () => {
  assert.deepEqual(sandboxPolicy("workspace-write", "C:\\repo"), {
    type: "workspaceWrite",
    writableRoots: ["C:\\repo"],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
});

test("uses a network-disabled read-only policy", () => {
  assert.deepEqual(sandboxPolicy("read-only", "C:\\repo"), {
    type: "readOnly",
    networkAccess: false,
  });
});

test("rejects a relative sandbox root", () => {
  assert.throws(() => sandboxPolicy("workspace-write", "relative"), /must be absolute/);
});

test("rejects a thread that already has an active turn", async () => {
  const client = new FakeClient();
  client.resumeThread = async ({ threadId }) => ({
    thread: { id: threadId, status: { type: "active", activeFlags: [] } },
  });
  const runner = new AppServerRunner(client, baseConfig());
  await assert.rejects(
    runner.run({ id: "job-1" }, { repositoryPath: "C:\\repo", resumeThreadId: "thread-1", prompt: "x" }),
    (error) => error.code === "THREAD_BUSY"
      && error.threadId === "thread-1"
      && error.conflictingTurnId === "turn-1",
  );
});

test("rejects a turn that raced with another client after start", async () => {
  const client = new FakeClient();
  client.listTurns = async () => ({
    data: [
      { id: "desktop-turn", status: "inProgress" },
      { id: "turn-1", status: "inProgress" },
    ],
  });
  let interrupted = null;
  client.interruptTurn = async (threadId, turnId) => { interrupted = { threadId, turnId }; };
  const runner = new AppServerRunner(client, baseConfig());
  await assert.rejects(
    runner.run({ id: "job-1" }, { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" }),
    (error) => error.code === "THREAD_BUSY"
      && error.threadId === "thread-1"
      && error.conflictingTurnId === "desktop-turn",
  );
  assert.deepEqual(interrupted, { threadId: "thread-1", turnId: "turn-1" });
});

test("interrupts a known failed orphan that appears after the new turn starts", async () => {
  const client = new FakeClient();
  client.listTurns = async () => ({
    data: [
      { id: "failed-orphan", status: "inProgress" },
      { id: "turn-1", status: "inProgress" },
    ],
  });
  const interrupts = [];
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };
  const runner = new AppServerRunner(client, baseConfig());

  const result = await runner.run(
    { id: "job-1" },
    {
      repositoryPath: "C:\\repo",
      resumeThreadId: null,
      prompt: "x",
      recoverableTurnIds: ["failed-orphan"],
    },
  );

  assert.deepEqual(interrupts, [{ threadId: "thread-1", turnId: "failed-orphan" }]);
  assert.equal(result.code, 0);
  assert.equal(result.completed, true);
});

test("accepts the exact completed turn before considering a newer desktop turn busy", async () => {
  const client = new FakeClient();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = async () => ({
    data: [
      { id: "desktop-turn", status: "inProgress", items: [] },
      {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "bridge done", phase: "final_answer" }],
      },
    ],
  });
  const interrupts = [];
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };

  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.deepEqual(interrupts, []);
  assert.equal(result.completed, true);
  assert.equal(result.lastMessage, "bridge done");
  assert.equal(result.code, 0);
});

test("preserves an exact early interrupted turn when a desktop turn is active", async () => {
  const client = new FakeClient();
  const interrupts = [];
  client.startTurn = async () => {
    queueMicrotask(() => client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", items: [] },
    }));
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  client.listTurns = async () => ({
    data: [{ id: "desktop-turn", status: "inProgress", items: [] }],
  });
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };

  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.deepEqual(interrupts, []);
  assert.equal(result.completed, false);
  assert.equal(result.code, 1);
});

test("records cancellation before startTurn responds and interrupts the real turn", async () => {
  const client = new FakeClient();
  const startRequested = deferred();
  const startResponse = deferred();
  const interrupts = [];
  client.startTurn = (params) => {
    client.startTurnParams = params;
    startRequested.resolve();
    return startResponse.promise;
  };
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };
  const runner = new AppServerRunner(client, baseConfig());
  const progress = [];
  runner.on("progress", (event) => progress.push(event));

  const run = runner.run(
    { id: "job-1", sourceMessageId: "om-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );
  await startRequested.promise;
  assert.equal(runner.findJob("thread-1", "turn-1"), null);
  client.emit("item/agentMessage/delta", {
    threadId: "thread-1", turnId: "desktop-turn", itemId: "desktop-item", delta: "desktop",
  });
  client.emit("approval-declined", {
    params: { threadId: "thread-1", turnId: "desktop-turn" },
  });
  assert.equal(await runner.cancel("job-1"), true);
  assert.deepEqual(interrupts, []);
  assert.deepEqual(progress, []);

  startResponse.resolve({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  const result = await run;
  assert.deepEqual(interrupts, [{ threadId: "thread-1", turnId: "turn-1" }]);
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.completed, false);
  assert.equal(result.timedOut, false);
});

test("records cancellation before thread creation responds and skips turn creation", async () => {
  const client = new FakeClient();
  const threadRequested = deferred();
  const threadResponse = deferred();
  let turnStarts = 0;
  client.startThread = () => {
    threadRequested.resolve();
    return threadResponse.promise;
  };
  client.startTurn = async () => {
    turnStarts += 1;
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  const runner = new AppServerRunner(client, baseConfig());
  const run = runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );
  await threadRequested.promise;
  assert.equal(await runner.cancel("job-1"), true);
  threadResponse.resolve({ thread: { id: "thread-1", status: { type: "idle" } } });
  const result = await run;
  assert.equal(turnStarts, 0);
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.turnId, null);
  assert.equal(result.completed, false);
});

test("findJob requires the exact non-empty active thread and turn", async () => {
  const client = new FakeClient();
  const listing = deferred();
  const interrupted = deferred();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = () => listing.promise;
  client.interruptTurn = () => interrupted.promise;
  const runner = new AppServerRunner(client, baseConfig());
  const started = new Promise((resolve) => runner.once("turn-started", resolve));
  const job = { id: "job-1" };
  const run = runner.run(
    job,
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );
  await started;
  assert.equal(runner.findJob("thread-1", "turn-1"), job);
  assert.equal(runner.findJob("thread-1"), null);
  assert.equal(runner.findJob("thread-1", ""), null);
  assert.equal(runner.findJob("thread-1", "desktop-turn"), null);
  assert.equal(runner.findJob("", "turn-1"), null);
  const cancellation = runner.cancel("job-1");
  assert.equal(runner.findJob("thread-1", "turn-1"), null);
  interrupted.resolve();
  assert.equal(await cancellation, true);
  const result = await run;
  assert.equal(result.completed, false);
});

test("interrupts a created turn when post-start verification fails", async () => {
  const client = new FakeClient();
  const interrupts = [];
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = async () => { throw new Error("turn verification failed"); };
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };
  const runner = new AppServerRunner(client, baseConfig());
  const result = await runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );
  assert.deepEqual(interrupts, [{ threadId: "thread-1", turnId: "turn-1" }]);
  assert.equal(result.completed, false);
  assert.match(result.errors.join("\n"), /turn verification failed/);
});

test("retries the transient not-materialized turn listing after start", async () => {
  const client = new FakeClient();
  client.startTurn = async (params) => {
    client.startTurnParams = params;
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      throw new Error("thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message");
    }
    queueMicrotask(() => {
      client.emit("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "done", phase: "final_answer" }],
        },
      });
    });
    return { data: [{ id: "turn-1", status: "inProgress" }] };
  };
  const runner = new AppServerRunner(client, baseConfig());
  const result = await runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );
  assert.equal(listings, 2);
  assert.equal(result.completed, true);
  assert.equal(result.lastMessage, "done");
});

test("retries while a new rollout file is still empty", async () => {
  const client = new FakeClient();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      throw new Error("failed to load thread history: failed to read session metadata C:\\rollout.jsonl: rollout at C:\\rollout.jsonl is empty");
    }
    queueMicrotask(() => client.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "done", phase: "final_answer" }],
      },
    }));
    return { data: [{ id: "turn-1", status: "inProgress" }] };
  };
  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );
  assert.equal(listings, 2);
  assert.equal(result.completed, true);
});

test("re-reads a completed turn until its final agent message materializes", async () => {
  const client = new FakeClient();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      queueMicrotask(() => {
        client.emit("item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "partial-item",
          delta: "partial result",
        });
        client.emit("turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        });
      });
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    if (listings === 2) {
      return {
        data: [{
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "   ", phase: "final_answer" }],
        }],
      };
    }
    return {
      data: [{
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "materialized result", phase: "final_answer" }],
      }],
    };
  };

  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(listings, 3);
  assert.equal(result.completed, true);
  assert.equal(result.lastMessage, "materialized result");
  assert.equal(result.code, 0);
});

test("merges a newer completed status with an already materialized final answer", async () => {
  const client = new FakeClient();
  client.startTurn = async () => {
    setImmediate(() => client.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "interrupted",
        items: [{ type: "agentMessage", text: "finished result", phase: "final_answer" }],
      },
    }));
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    return { data: [{ id: "turn-1", status: "completed", items: [] }] };
  };

  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(listings, 2);
  assert.equal(result.completed, true);
  assert.equal(result.lastMessage, "finished result");
  assert.equal(result.code, 0);
});

test("uses a streamed final answer when the completed turn snapshot is empty", async () => {
  const client = new FakeClient();
  client.startTurn = async () => {
    setImmediate(() => {
      client.emit("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "final-1", type: "agentMessage", phase: "final_answer" },
      });
      client.emit("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "final-1",
        delta: "streamed result",
      });
      client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      });
    });
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    return { data: [{ id: "turn-1", status: "completed", items: [] }] };
  };

  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(listings, 1);
  assert.equal(result.completed, true);
  assert.equal(result.lastMessage, "streamed result");
  assert.equal(result.code, 0);
});

test("does not use streamed commentary as a final-answer fallback", async () => {
  const client = new FakeClient();
  client.startTurn = async () => {
    setImmediate(() => {
      client.emit("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "commentary-1", type: "agentMessage", phase: "commentary" },
      });
      client.emit("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "commentary-1",
        delta: "still working",
      });
      client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      });
    });
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    return { data: [{ id: "turn-1", status: "completed", items: [] }] };
  };
  const runner = new AppServerRunner(client, baseConfig());
  runner.materializationRetryBudgetMs = 25;
  runner.materializationRetryDelayMs = 5;

  const result = await runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(result.completed, true);
  assert.equal(result.lastMessage, "");
  assert.equal(result.code, 1);
});

test("does not finalize an empty completion candidate that returns to in-progress", async () => {
  const client = new FakeClient();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      return { data: [{ id: "turn-1", status: "completed", items: [] }] };
    }
    setImmediate(() => client.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "actual later result", phase: "final_answer" }],
      },
    }));
    return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
  };

  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(listings, 2);
  assert.equal(result.completed, true);
  assert.equal(result.lastMessage, "actual later result");
  assert.equal(result.code, 0);
});

test("does not report a transient empty interrupted candidate when the turn later completes", async () => {
  const client = new FakeClient();
  client.startTurn = async () => {
    setImmediate(() => client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", items: [], error: null },
    }));
    setTimeout(() => client.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "eventual answer", phase: "final_answer" }],
      },
    }), 25);
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  client.listTurns = async () => ({
    data: [{ id: "turn-1", status: "inProgress", items: [] }],
  });
  const runner = new AppServerRunner(client, baseConfig());
  runner.materializationRetryBudgetMs = 100;
  runner.materializationRetryDelayMs = 5;
  runner.terminalStabilityMs = 20;

  const result = await runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "hi" },
  );

  assert.equal(result.code, 0);
  assert.equal(result.completed, true);
  assert.equal(result.lastMessage, "eventual answer");
});

test("recognizes structured and wording-varied materialization readiness errors", () => {
  assert.equal(transientTurnListError({ code: "THREAD_NOT_MATERIALIZED" }), true);
  assert.equal(transientTurnListError({ data: { kind: "session_not_ready" } }), true);
  assert.equal(transientTurnListError(new Error(
    "session history is temporarily unavailable while rollout is being written",
  )), true);
  assert.equal(transientTurnListError(new Error("thread permission denied")), false);
});

test("bounds repeated materialization retries by a deadline", async () => {
  const client = new FakeClient();
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    const error = new Error("thread history is not ready");
    error.code = "SESSION_NOT_READY";
    throw error;
  };
  const runner = new AppServerRunner(client, baseConfig());
  const startedAt = Date.now();
  await assert.rejects(
    runner.listTurnsAfterStart("thread-1", new Promise(() => {}), {
      retryBudgetMs: 25,
      delayMs: 5,
    }),
    /not ready/,
  );
  assert.ok(listings >= 1);
  assert.ok(listings < 20);
  assert.ok(Date.now() - startedAt < 250);
});

test("retries a successful post-start listing until the exact new turn appears", async () => {
  const client = new FakeClient();
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      return { data: [{ id: "desktop-turn", status: "inProgress", items: [] }] };
    }
    return {
      data: [
        { id: "desktop-turn", status: "inProgress", items: [] },
        { id: "turn-1", status: "inProgress", items: [] },
      ],
    };
  };
  const runner = new AppServerRunner(client, baseConfig());

  const result = await runner.listTurnsAfterStart(
    "thread-1",
    new Promise(() => {}),
    { expectedTurnId: "turn-1", retryBudgetMs: 100, delayMs: 5 },
  );

  assert.equal(listings, 2);
  assert.equal(result.data.some((turn) => turn.id === "turn-1"), true);
});

test("bounds a single post-start turn listing by the verification deadline", async () => {
  const client = new FakeClient();
  client.listTurns = () => new Promise(() => {});
  const runner = new AppServerRunner(client, baseConfig());
  const startedAt = Date.now();

  await assert.rejects(
    runner.listTurnsAfterStart("thread-1", new Promise(() => {}), {
      retryBudgetMs: 25,
      delayMs: 5,
    }),
    (error) => error?.code === "TURN_LIST_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 250);
});

test("bounds a single completed-turn materialization read by the deadline", async () => {
  const client = new FakeClient();
  client.listTurns = () => new Promise(() => {});
  const runner = new AppServerRunner(client, baseConfig());
  const initialTurn = { id: "turn-1", status: "completed", items: [] };
  const startedAt = Date.now();

  const result = await runner.materializeCompletedTurn(
    "thread-1",
    "turn-1",
    initialTurn,
    new Promise(() => {}),
    () => initialTurn,
    { retryBudgetMs: 25, delayMs: 5 },
  );

  assert.equal(result.type, "terminal");
  assert.equal(result.turn, initialTurn);
  assert.ok(Date.now() - startedAt < 250);
});

test("retains an exact completion event that arrives before the start response", async () => {
  const client = new FakeClient();
  client.startTurn = async () => {
    queueMicrotask(() => {
      client.emit("item/agentMessage/delta", {
        threadId: "thread-1", turnId: "turn-1", itemId: "item-early", delta: "untrusted early text",
      });
      client.emit("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "verified early result", phase: "final_answer" }],
        },
      });
    });
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  client.listTurns = async () => ({
    data: [{ id: "turn-1", status: "inProgress", items: [] }],
  });
  const config = baseConfig();
  config.codex.maxRuntimeMinutes = 0.001;
  const runner = new AppServerRunner(client, config);
  const progress = [];
  runner.on("progress", (event) => progress.push(event));
  const result = await runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );
  assert.deepEqual(progress, []);
  assert.equal(result.lastMessage, "verified early result");
  assert.equal(result.completed, true);
});

test("does not let post-start verification overwrite an authoritative early final", async () => {
  const client = new FakeClient();
  let listings = 0;
  client.startTurn = async () => {
    queueMicrotask(() => client.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "authoritative early final", phase: "final_answer" }],
      },
    }));
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  client.listTurns = async () => {
    listings += 1;
    throw new Error("post-start listing must be skipped");
  };

  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(listings, 0);
  assert.equal(result.lastMessage, "authoritative early final");
  assert.equal(result.code, 0);
});

test("lets an exact final arriving during verification outrank a stale verification error", async () => {
  const client = new FakeClient();
  const listing = deferred();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = () => listing.promise;
  const runner = new AppServerRunner(client, baseConfig());
  const started = new Promise((resolve) => runner.once("turn-started", resolve));
  const run = runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  await started;
  client.emit("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "newer exact final", phase: "final_answer" }],
    },
  });
  listing.reject(new Error("stale verification failure"));
  const result = await run;

  assert.equal(result.lastMessage, "newer exact final");
  assert.equal(result.code, 0);
  assert.equal(result.errors.includes("stale verification failure"), false);
});

test("materializes an early empty completion from exact listings without a second event", async () => {
  const client = new FakeClient();
  client.startTurn = async () => {
    queueMicrotask(() => client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    }));
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) return { data: [] };
    if (listings === 2) {
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    if (listings === 3) {
      return { data: [{ id: "turn-1", status: "completed", items: [] }] };
    }
    return {
      data: [{
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "persisted final", phase: "final_answer" }],
      }],
    };
  };

  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(listings, 4);
  assert.equal(result.completed, true);
  assert.equal(result.lastMessage, "persisted final");
  assert.equal(result.code, 0);
});

test("switches from one bounded materialization window to low-frequency exact reconciliation", async () => {
  const client = new FakeClient();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = async () => ({
    data: [{ id: "turn-1", status: "completed", items: [] }],
  });
  const runner = new AppServerRunner(client, baseConfig());
  runner.pendingReconcileIntervalMs = 1;
  let materializationWindows = 0;
  let reconciliations = 0;
  runner.materializeCompletedTurn = async () => {
    materializationWindows += 1;
    return {
      type: "pending",
      pendingObserved: true,
      turn: { id: "turn-1", status: "completed", items: [] },
    };
  };
  runner.reconcilePendingTurn = async () => {
    reconciliations += 1;
    return {
      type: "materialized",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "reconciled final", phase: "final_answer" }],
      },
    };
  };

  const result = await runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(materializationWindows, 1);
  assert.equal(reconciliations, 1);
  assert.equal(result.lastMessage, "reconciled final");
  assert.equal(result.code, 0);
});

test("does not overwrite a newer interrupted event with a stale completed-empty retry", async () => {
  const client = new FakeClient();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = async () => ({
    data: [{ id: "turn-1", status: "completed", items: [] }],
  });
  const runner = new AppServerRunner(client, baseConfig());
  let materializationCalls = 0;
  runner.materializeCompletedTurn = async () => {
    materializationCalls += 1;
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", items: [] },
    });
    return {
      type: "pending",
      pendingObserved: true,
      turn: { id: "turn-1", status: "completed", items: [] },
    };
  };

  const result = await runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(materializationCalls, 1);
  assert.equal(result.completed, false);
  assert.equal(result.code, 1);
});

test("does not accept a stale materialized final over a newer interrupted event", async () => {
  const client = new FakeClient();
  const materializationStarted = deferred();
  const staleListing = deferred();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  let listings = 0;
  client.listTurns = () => {
    listings += 1;
    if (listings === 1) {
      queueMicrotask(() => client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      }));
      return Promise.resolve({ data: [{ id: "turn-1", status: "inProgress", items: [] }] });
    }
    materializationStarted.resolve();
    return staleListing.promise;
  };
  const runner = new AppServerRunner(client, baseConfig());
  const run = runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  await materializationStarted.promise;
  client.emit("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "interrupted", items: [] },
  });
  staleListing.resolve({
    data: [{
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "stale final", phase: "final_answer" }],
    }],
  });
  const result = await run;

  assert.equal(result.completed, false);
  assert.equal(result.lastMessage, "");
  assert.equal(result.code, 1);
});

test("does not accept a stale reconciled final over a newer failed event", async () => {
  const client = new FakeClient();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = async () => ({
    data: [{ id: "turn-1", status: "completed", items: [] }],
  });
  const runner = new AppServerRunner(client, baseConfig());
  runner.pendingReconcileIntervalMs = 1;
  runner.materializeCompletedTurn = async () => ({
    type: "pending",
    observedStatus: "inProgress",
    pendingObserved: true,
    turn: { id: "turn-1", status: "completed", items: [] },
  });
  const reconcileStarted = deferred();
  const staleReconcile = deferred();
  runner.reconcilePendingTurn = async () => {
    reconcileStarted.resolve();
    return staleReconcile.promise;
  };
  const run = runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  await reconcileStarted.promise;
  client.emit("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "failed", items: [], error: { message: "exact failure" } },
  });
  staleReconcile.resolve({
    type: "materialized",
    turn: {
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "stale reconciled final", phase: "final_answer" }],
    },
  });
  const result = await run;

  assert.equal(result.completed, false);
  assert.match(result.errors.join("\n"), /exact failure/);
  assert.equal(result.lastMessage, "");
});

test("keeps approvals closed when a completion candidate is only missing from history", async () => {
  const client = new FakeClient();
  const job = { id: "job-1" };
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = async () => ({
    data: [{ id: "turn-1", status: "completed", items: [] }],
  });
  const runner = new AppServerRunner(client, baseConfig());
  runner.pendingReconcileIntervalMs = 1;
  runner.materializeCompletedTurn = async () => ({
    type: "pending",
    observedStatus: "missing",
    pendingObserved: true,
    turn: { id: "turn-1", status: "completed", items: [] },
  });
  runner.reconcilePendingTurn = async () => {
    assert.equal(runner.findJob("thread-1", "turn-1"), null);
    return {
      type: "materialized",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "history recovered", phase: "final_answer" }],
      },
    };
  };

  const result = await runner.run(
    job,
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(result.lastMessage, "history recovered");
});

test("recloses approvals when reconciliation returns to completed-empty", async () => {
  const client = new FakeClient();
  const job = { id: "job-1" };
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = async () => ({
    data: [{ id: "turn-1", status: "completed", items: [] }],
  });
  const runner = new AppServerRunner(client, baseConfig());
  runner.pendingReconcileIntervalMs = 1;
  const approvalCloses = [];
  runner.on("turn-approval-close", (event) => approvalCloses.push(event));
  runner.materializeCompletedTurn = async () => ({
    type: "pending",
    observedStatus: "inProgress",
    pendingObserved: true,
    turn: { id: "turn-1", status: "completed", items: [] },
  });
  let reconciliations = 0;
  runner.reconcilePendingTurn = async () => {
    reconciliations += 1;
    if (reconciliations === 1) {
      assert.equal(runner.findJob("thread-1", "turn-1"), job);
      return { type: "pending", observedStatus: "completed" };
    }
    assert.equal(runner.findJob("thread-1", "turn-1"), null);
    return {
      type: "materialized",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "closed again", phase: "final_answer" }],
      },
    };
  };

  const result = await runner.run(
    job,
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(reconciliations, 2);
  assert.equal(approvalCloses.length, 2);
  assert.equal(result.lastMessage, "closed again");
});

test("recloses approvals when reconciliation loses an explicit in-progress turn", async () => {
  const client = new FakeClient();
  const job = { id: "job-1" };
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = async () => ({
    data: [{ id: "turn-1", status: "completed", items: [] }],
  });
  const runner = new AppServerRunner(client, baseConfig());
  runner.pendingReconcileIntervalMs = 1;
  const approvalCloses = [];
  runner.on("turn-approval-close", (event) => approvalCloses.push(event));
  runner.materializeCompletedTurn = async () => ({
    type: "pending",
    observedStatus: "inProgress",
    pendingObserved: true,
    turn: { id: "turn-1", status: "completed", items: [] },
  });
  let reconciliations = 0;
  runner.reconcilePendingTurn = async () => {
    reconciliations += 1;
    if (reconciliations === 1) {
      assert.equal(runner.findJob("thread-1", "turn-1"), job);
      return { type: "pending", observedStatus: "missing" };
    }
    assert.equal(runner.findJob("thread-1", "turn-1"), null);
    return {
      type: "materialized",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "history returned", phase: "final_answer" }],
      },
    };
  };

  const result = await runner.run(
    job,
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(reconciliations, 2);
  assert.equal(approvalCloses.length, 2);
  assert.equal(approvalCloses[1].status, "missing");
  assert.equal(result.lastMessage, "history returned");
});

test("accepts a later exact interrupted event while a completed candidate materializes", async () => {
  const client = new FakeClient();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      queueMicrotask(() => client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      }));
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    queueMicrotask(() => client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", items: [] },
    }));
    return { data: [{ id: "turn-1", status: "completed", items: [] }] };
  };

  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.equal(listings, 2);
  assert.equal(result.completed, false);
  assert.equal(result.code, 1);
});

test("does not treat a desktop turn as conflicting after an exact completed candidate", async () => {
  const client = new FakeClient();
  const interrupts = [];
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      queueMicrotask(() => client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      }));
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    if (listings === 2) {
      return {
        data: [
          { id: "desktop-turn", status: "inProgress", items: [] },
          { id: "turn-1", status: "inProgress", items: [] },
        ],
      };
    }
    return {
      data: [
        { id: "desktop-turn", status: "inProgress", items: [] },
        {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "exact bridge final", phase: "final_answer" }],
        },
      ],
    };
  };
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };

  const result = await new AppServerRunner(client, baseConfig()).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.deepEqual(interrupts, []);
  assert.equal(result.lastMessage, "exact bridge final");
  assert.equal(result.code, 0);
});

test("grants final-message materialization grace without timing out a completed turn", async () => {
  const client = new FakeClient();
  const interrupts = [];
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      queueMicrotask(() => client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      }));
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      data: [{
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "graceful final", phase: "final_answer" }],
      }],
    };
  };
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };
  const config = baseConfig();
  config.codex.maxRuntimeMinutes = 0.0001;

  const result = await new AppServerRunner(client, config).run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.deepEqual(interrupts, []);
  assert.equal(result.timedOut, false);
  assert.equal(result.lastMessage, "graceful final");
  assert.equal(result.code, 0);
});

test("lets a completed-empty materialization deadline finish before timeout grace expires", async () => {
  const client = new FakeClient();
  const interrupts = [];
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      queueMicrotask(() => client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      }));
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    return { data: [{ id: "turn-1", status: "completed", items: [] }] };
  };
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };
  const config = baseConfig();
  config.codex.maxRuntimeMinutes = 0.0001;
  const runner = new AppServerRunner(client, config);
  runner.materializationRetryBudgetMs = 25;
  runner.materializationRetryDelayMs = 5;
  runner.materializationGraceBufferMs = 25;

  const result = await runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.deepEqual(interrupts, []);
  assert.equal(result.timedOut, false);
  assert.equal(result.completed, true);
  assert.equal(result.lastMessage, "");
  assert.equal(result.code, 1);
});

test("does not interrupt when low-frequency reconciliation last confirmed completed-empty", async () => {
  const client = new FakeClient();
  const interrupts = [];
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = async () => ({
    data: [{ id: "turn-1", status: "completed", items: [] }],
  });
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };
  const config = baseConfig();
  config.codex.maxRuntimeMinutes = 0.0001;
  const runner = new AppServerRunner(client, config);
  runner.materializationRetryBudgetMs = 1;
  runner.materializationGraceBufferMs = 20;
  runner.pendingReconcileIntervalMs = 1;
  runner.materializeCompletedTurn = async () => ({
    type: "pending",
    observedStatus: "inProgress",
    pendingObserved: true,
    turn: { id: "turn-1", status: "completed", items: [] },
  });
  runner.reconcilePendingTurn = async () => ({
    type: "pending",
    observedStatus: "completed",
  });

  const result = await runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  assert.deepEqual(interrupts, []);
  assert.equal(result.timedOut, false);
  assert.equal(result.completed, true);
  assert.equal(result.code, 1);
});

test("cancels terminal materialization without interrupting the completed turn", async () => {
  const client = new FakeClient();
  const materializationRead = deferred();
  const interrupts = [];
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      queueMicrotask(() => client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      }));
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    if (listings === 2) {
      materializationRead.resolve();
      return { data: [{ id: "turn-1", status: "completed", items: [] }] };
    }
    return {
      data: [{
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "finished safely", phase: "final_answer" }],
      }],
    };
  };
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };
  const runner = new AppServerRunner(client, baseConfig());
  const run = runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  await materializationRead.promise;
  assert.equal(runner.findJob("thread-1", "turn-1"), null);
  const canceledAt = Date.now();
  assert.equal(await runner.cancel("job-1"), true);
  const result = await run;

  assert.deepEqual(interrupts, []);
  assert.equal(listings, 2);
  assert.equal(result.completed, false);
  assert.equal(result.lastMessage, "");
  assert.ok(Date.now() - canceledAt < 250);
});

test("interrupts a turn when cancellation follows an in-progress materialization read", async () => {
  const client = new FakeClient();
  const pendingRead = deferred();
  const interrupts = [];
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  let listings = 0;
  client.listTurns = async () => {
    listings += 1;
    if (listings === 1) {
      queueMicrotask(() => client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      }));
      return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
    }
    pendingRead.resolve();
    return { data: [{ id: "turn-1", status: "inProgress", items: [] }] };
  };
  client.interruptTurn = async (threadId, turnId) => { interrupts.push({ threadId, turnId }); };
  const runner = new AppServerRunner(client, baseConfig());
  const run = runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  await pendingRead.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await runner.cancel("job-1"), true);
  const result = await run;

  assert.deepEqual(interrupts, [{ threadId: "thread-1", turnId: "turn-1" }]);
  assert.equal(result.completed, false);
});

test("keeps a turn active when interruption cannot be confirmed", async () => {
  const client = new FakeClient();
  const listing = deferred();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = () => listing.promise;
  client.interruptTurn = async () => { throw new Error("interrupt transport failed"); };
  const runner = new AppServerRunner(client, baseConfig());
  const run = runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );
  await new Promise((resolve) => runner.once("turn-started", resolve));
  await assert.rejects(runner.cancel("job-1"), /interrupt transport failed/);
  assert.deepEqual(runner.activeJobIds(), ["job-1"]);
  assert.equal(runner.findJob("thread-1", "turn-1"), null);
  listing.reject(new Error("verification stopped"));
  await assert.rejects(run, (error) => error?.code === "TURN_INTERRUPT_UNCONFIRMED");
  assert.deepEqual(runner.activeJobIds(), []);
});

test("rejects instead of hanging when timeout interruption cannot be confirmed", async () => {
  const client = new FakeClient();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.interruptTurn = async () => { throw new Error("interrupt transport failed"); };
  const config = baseConfig();
  config.codex.maxRuntimeMinutes = 0.0001;
  const runner = new AppServerRunner(client, config);
  const run = runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );
  const outcome = await Promise.race([
    run.then(
      () => ({ type: "resolved" }),
      (error) => ({ type: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ type: "hung" }), 250)),
  ]);
  assert.equal(outcome.type, "rejected");
  assert.equal(outcome.error?.code, "TURN_INTERRUPT_UNCONFIRMED");
  assert.deepEqual(runner.activeJobIds(), []);
});

test("keeps timeout sticky when a completed event arrives during interruption", async () => {
  const client = new FakeClient();
  const interruptStarted = deferred();
  const interruptReleased = deferred();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = async () => ({
    data: [{ id: "turn-1", status: "inProgress", items: [] }],
  });
  client.interruptTurn = async () => {
    interruptStarted.resolve();
    return interruptReleased.promise;
  };
  const config = baseConfig();
  config.codex.maxRuntimeMinutes = 0.0001;
  const runner = new AppServerRunner(client, config);
  const run = runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );

  await interruptStarted.promise;
  client.emit("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "too late", phase: "final_answer" }],
    },
  });
  interruptReleased.resolve();
  const result = await run;

  assert.equal(result.timedOut, true);
  assert.equal(result.completed, false);
  assert.equal(result.lastMessage, "");
  assert.equal(result.code, 1);
});

test("emits interrupting before awaiting the interrupt request", async () => {
  const client = new FakeClient();
  const listing = deferred();
  const interrupt = deferred();
  client.startTurn = async () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } });
  client.listTurns = () => listing.promise;
  client.interruptTurn = () => interrupt.promise;
  const runner = new AppServerRunner(client, baseConfig());
  const events = [];
  runner.on("interrupting", (event) => events.push(event));
  const run = runner.run(
    { id: "job-1" },
    { repositoryPath: "C:\\repo", resumeThreadId: null, prompt: "x" },
  );
  await new Promise((resolve) => runner.once("turn-started", resolve));
  const cancellation = runner.cancel("job-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "cancel");
  interrupt.resolve();
  assert.equal(await cancellation, true);
  await run;
});
