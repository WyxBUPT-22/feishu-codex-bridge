import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SUPPORTED_LARK_CLI_VERSION } from "../src/lark-version.js";

const DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
  "request_permissions_tool",
  "tool_suggest",
  "workspace_dependencies",
];

function isolatedConfig(hook) {
  return {
    mcp_servers: {},
    plugins: {},
    marketplaces: {},
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    },
    notify: [],
    allow_login_shell: false,
    hooks: {
      PreToolUse: [{
        matcher: hook.matcher,
        hooks: [{
          type: "command",
          command: hook.command,
          commandWindows: hook.commandWindows,
          timeout: hook.timeout,
          async: false,
          statusMessage: null,
        }],
      }],
      PermissionRequest: [],
      PostToolUse: [],
      PreCompact: [],
      PostCompact: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
      Stop: [],
    },
    tools: { web_search: null },
    web_search: "disabled",
    include_apps_instructions: false,
    skills: { include_instructions: false },
    orchestrator: { skills: { enabled: false }, mcp: { enabled: false } },
    features: {
      ...Object.fromEntries(DISABLED_FEATURES.map((name) => [name, false])),
      hooks: true,
    },
  };
}

function fakeCodexSource() {
  return `
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.144.1");
  process.exit(0);
}
const DISABLED_FEATURES = ${JSON.stringify(DISABLED_FEATURES)};
const hookArg = process.argv.find((arg) => arg.startsWith("hooks.PreToolUse="));
const trusted = process.argv.some((arg) => arg.startsWith("hooks.state="));
const hookValue = hookArg?.slice("hooks.PreToolUse=".length) ?? "";
const jsonField = (name) => {
  const marker = name + "=";
  const markerAt = hookValue.indexOf(marker);
  if (markerAt < 0) return null;
  const start = markerAt + marker.length;
  if (hookValue[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < hookValue.length; index += 1) {
    const character = hookValue[index];
    if (character === '"' && !escaped) return JSON.parse(hookValue.slice(start, index + 1));
    if (character === "\\\\" && !escaped) escaped = true;
    else escaped = false;
  }
  return null;
};
const hook = {
  matcher: jsonField("matcher"),
  command: jsonField("command"),
  commandWindows: jsonField("command_windows"),
  timeout: Number(hookValue.slice(hookValue.indexOf("timeout=") + 8).split(/[^0-9]/, 1)[0] ?? 0),
};
const config = ${isolatedConfig.toString()}(hook);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message, callback) => process.stdout.write(JSON.stringify(message) + "\\n", callback);
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
  } else if (message.method === "config/read") {
    send({ id: message.id, result: { config } });
  } else if (message.method === "hooks/list") {
    send({ id: message.id, result: { data: [{
      cwd: message.params.cwds[0], warnings: [], errors: [], hooks: [{
        key: "session-hook", eventName: "preToolUse", handlerType: "command",
        matcher: hook.matcher, command: hook.commandWindows ?? hook.command,
        timeoutSec: hook.timeout, enabled: true, isManaged: false,
        currentHash: "sha256:${"a".repeat(64)}", trustStatus: trusted ? "trusted" : "untrusted", source: "sessionFlags",
      }],
    }] } }, () => {
      if (trusted) setTimeout(() => process.exit(17), 5);
    });
  }
});
`;
}

async function waitForClose(child, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      once(child, "close"),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("bridge did not exit after app-server failure")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("startup rejects an unsupported Feishu CLI before acquiring the instance lock", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-lark-startup-version-"));
  const repository = path.join(root, "repository");
  const dataDirectory = path.join(root, "data");
  const codexEntry = path.join(root, "fake-codex.js");
  const larkEntry = path.join(root, "fake-lark.js");
  const codexStartedPath = path.join(root, "codex-started");
  const configPath = path.join(root, "bridge.config.json");
  await Promise.all([
    mkdir(repository),
    mkdir(dataDirectory),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const [major, minor, patch] = SUPPORTED_LARK_CLI_VERSION.split(".").map(Number);
  const mismatched = `${major}.${minor}.${patch + 1}`;
  await writeFile(larkEntry, `console.log("lark-cli version ${mismatched}");\n`);
  await writeFile(codexEntry, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(codexStartedPath)}, "started");
`);
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    dataDirectory,
    larkCliEntry: larkEntry,
    lark: {
      profile: "test",
      allowedSenders: ["ou_allowed"],
      allowedChats: [],
      p2pOnly: true,
    },
    repositories: { repo: { path: repository } },
    defaultRepository: "repo",
    codex: {
      entry: codexEntry,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      appServer: { enabled: true },
    },
    queue: { concurrency: 1 },
  })}\n`);

  const result = spawnSync(
    process.execPath,
    [path.resolve("src/main.js"), "start", "--config", configPath],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`Unsupported Feishu CLI version ${mismatched.replaceAll(".", "\\.")}`));
  await assert.rejects(access(path.join(dataDirectory, "bridge.lock")), { code: "ENOENT" });
  await assert.rejects(access(codexStartedPath), { code: "ENOENT" });
});

test("startup app-server exit is fatal, drains startup work, and releases the instance lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-startup-"));
  const repository = path.join(directory, "repository");
  const dataDirectory = path.join(directory, "data");
  const codexHome = path.join(directory, "codex-home");
  const localAppData = path.join(directory, "local-app-data");
  const codexEntry = path.join(directory, "fake-codex.js");
  const larkEntry = path.join(directory, "fake-lark.js");
  const larkStartedPath = path.join(directory, "lark-started");
  const configPath = path.join(directory, "bridge.config.json");
  await Promise.all([
    mkdir(repository, { recursive: true }),
    mkdir(dataDirectory, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
  ]);

  const jobs = Object.fromEntries(Array.from({ length: 100 }, (_, index) => {
    const id = `job-${index}`;
    return [id, { id, status: "running", createdAt: new Date(0).toISOString() }];
  }));
  await writeFile(path.join(dataDirectory, "state.json"), `${JSON.stringify({
    version: 1,
    processedMessages: [],
    preferences: {},
    sessions: {},
    jobs,
  })}\n`);
  await writeFile(codexEntry, fakeCodexSource());
  await writeFile(larkEntry, `
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("lark-cli version ${SUPPORTED_LARK_CLI_VERSION}");
  process.exit(0);
}
writeFileSync(${JSON.stringify(larkStartedPath)}, "started");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
setTimeout(() => process.exit(29), 2000);
`);
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    dataDirectory,
    larkCliEntry: larkEntry,
    lark: {
      profile: "test",
      allowedSenders: ["ou_allowed"],
      allowedChats: [],
      p2pOnly: true,
      allowedMessageTypes: ["text", "post"],
      maxMessageAgeMinutes: 10,
    },
    repositories: { repo: { path: repository } },
    defaultRepository: "repo",
    codex: {
      entry: codexEntry,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      maxRuntimeMinutes: 60,
      appServer: { enabled: true },
    },
    queue: { concurrency: 1 },
    limits: {
      maxPromptChars: 8000,
      maxReplyChars: 12000,
      processedMessageLimit: 2000,
      storedJobLimit: 500,
    },
  })}\n`);

  const mainPath = path.resolve("src/main.js");
  const child = spawn(process.execPath, [mainPath, "start", "--config", configPath], {
    cwd: path.resolve("."),
    env: { ...process.env, CODEX_HOME: codexHome, LOCALAPPDATA: localAppData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    const [code, signal] = await waitForClose(child, 6_000);
    assert.equal(code, 1);
    assert.equal(signal, null);
    assert.match(stdout, /Codex app-server session backend is ready/, stderr);
    assert.doesNotMatch(stdout, /Feishu event stream is ready/);
    assert.match(stderr, /Codex app-server exited unexpectedly \(code=17, signal=null\)/);
    await assert.rejects(access(larkStartedPath), (error) => error.code === "ENOENT");
    await assert.rejects(
      access(path.join(dataDirectory, "bridge.lock")),
      (error) => error.code === "ENOENT",
    );
    const state = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
    assert.equal(Object.values(state.jobs).every((job) => job.status === "interrupted"), true);
    const hookRoot = path.join(
      localAppData,
      "feishu-codex-bridge",
      "codex-home",
      "bridge-hooks",
    );
    const hookEntries = await readdir(hookRoot).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(hookEntries, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
