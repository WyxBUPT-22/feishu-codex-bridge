import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CodexRunner,
  captureStdinErrors,
  codexEnvironment,
  parseCodexEvent,
} from "../src/codex-runner.js";
import { baseConfig } from "./helpers.js";

const tool = { command: "codex", prefixArgs: [], displayName: "codex" };

test("builds safe new-session arguments with stdin prompt", () => {
  const runner = new CodexRunner(tool, baseConfig());
  const args = runner.buildArgs({ repositoryPath: "C:\\repo", resumeThreadId: null });
  assert.deepEqual(args, [
    "--ask-for-approval", "never",
    "--cd", "C:\\repo",
    "--sandbox", "workspace-write",
    "exec",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "-",
  ]);
});

test("builds resume arguments without unsupported exec options", () => {
  const runner = new CodexRunner(tool, baseConfig());
  const args = runner.buildArgs({ repositoryPath: "C:\\repo", resumeThreadId: "thread-1" });
  assert.deepEqual(args, [
    "--ask-for-approval", "never",
    "--cd", "C:\\repo",
    "--sandbox", "workspace-write",
    "exec", "resume",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "thread-1",
    "-",
  ]);
});

test("passes only the configured model provider fields", () => {
  const config = baseConfig();
  config.codex.model = "gpt-test";
  config.codex.provider = {
    id: "private_provider",
    name: "Private Provider",
    baseUrl: "https://example.test/v1",
    wireApi: "responses",
    requiresOpenAIAuth: true,
  };
  const runner = new CodexRunner(tool, config);
  const args = runner.buildArgs({ repositoryPath: "C:\\repo", resumeThreadId: null });
  assert.deepEqual(args.slice(6, 18), [
    "--config", 'model_provider="private_provider"',
    "--config", 'model_providers.private_provider.name="Private Provider"',
    "--config", 'model_providers.private_provider.base_url="https://example.test/v1"',
    "--config", 'model_providers.private_provider.wire_api="responses"',
    "--config", "model_providers.private_provider.requires_openai_auth=true",
    "--model", "gpt-test",
  ]);
});

test("removes Feishu credentials from the Codex process environment", () => {
  assert.deepEqual(
    codexEnvironment({
      PATH: "bin",
      USERPROFILE: "C:\\Users\\test",
      LARK_APP_SECRET: "secret",
      LARKSUITE_TOKEN: "token",
      FEISHU_TOKEN: "token",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "github-secret",
      DATABASE_URL: "database-secret",
    }),
    { PATH: "bin", USERPROFILE: "C:\\Users\\test" },
  );
});

test("cancel waits for process-tree termination", async () => {
  const runner = new CodexRunner(tool, baseConfig());
  let resolved = false;
  runner.active.set("job-1", {
    child: {
      pid: 123,
      exitCode: 0,
      signalCode: null,
    },
    termination: new Promise((resolve) => setTimeout(() => {
      resolved = true;
      resolve(true);
    }, 5)),
  });
  assert.equal(await runner.cancel("job-1"), true);
  assert.equal(resolved, true);
  assert.equal(await runner.cancel("missing"), false);
});

test("captures early stdin failures without an unhandled error", () => {
  const stream = new EventEmitter();
  const errors = [];
  captureStdinErrors(stream, errors);
  assert.doesNotThrow(() => stream.emit("error", new Error("EPIPE")));
  assert.deepEqual(errors, ["Codex stdin error: EPIPE"]);
});

test("parses thread id, final assistant text and completion", () => {
  const state = { threadId: null, lastMessage: "", errors: [], completed: false };
  parseCodexEvent('{"type":"thread.started","thread_id":"t1"}', state);
  parseCodexEvent('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}', state);
  parseCodexEvent('{"type":"turn.completed"}', state);
  assert.deepEqual(state, { threadId: "t1", lastMessage: "done", errors: [], completed: true });
});
